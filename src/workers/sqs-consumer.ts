import { createHash } from 'node:crypto';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, ChangeMessageVisibilityCommand, type Message } from '@aws-sdk/client-sqs';
import { stringContract, wagerContract } from '../shared/application/contracts';
import { ApplicationError } from '../shared/application/application-error';
import type { WagerPayload } from '../wagering/application/canonical-payload';
import type { SubmitWager } from '../wagering/application/submit-wager';
import type { ProcessingResponse } from '../wagering/application/processing-result';
import { classifyFailure, retryDelaySeconds, settleWithin } from './worker-lifecycle';

interface Envelope { messageId: string; type: 'WagerTransactionRequested'; occurredAt: string; data: WagerPayload & { idempotencyKey: string }; }
export interface ConsumerOptions {
  waitTimeSeconds?: number; dlqUrl?: string; visibilityTimeoutSeconds?: number; heartbeatMs?: number;
  databaseAvailable?: () => Promise<boolean>; afterCommitBeforeAck?: (message: Message) => Promise<void>;
  afterDlqSendBeforeAck?: (message: Message) => Promise<void>;
  sqsRequestTimeoutMs?: number; receiveTimeoutMs?: number;
}
interface ActiveMessage { receipt: string; abandoned: boolean; heartbeatStopped?: boolean; timer?: ReturnType<typeof setTimeout>; renewal?: Promise<void>; }
function invalid(): never { throw new ApplicationError('INVALID_ENVELOPE', 'Envelope de mensagem inválido.', 400); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function isoTimestamp(input: unknown): string {
  const value = stringContract(input, 35);
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value)) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59
    || Number(parts[5] ?? 0) > 23 || Number(parts[6] ?? 0) > 59) invalid();
  const calendar = new Date(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== parts[1]) invalid();
  return value;
}
export function wagerEnvelope(input: unknown): Envelope {
  const value = object(input, ['messageId', 'type', 'occurredAt', 'data']);
  if (value.type !== 'WagerTransactionRequested') invalid();
  const occurredAt = isoTimestamp(value.occurredAt);
  const data = object(value.data, ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId']);
  const { idempotencyKey, ...business } = data;
  return { messageId: stringContract(value.messageId, 200), type: value.type, occurredAt,
    data: { ...wagerContract(business), idempotencyKey: stringContract(idempotencyKey, 320) } };
}
// Hash do envelope validado inteiro, incluindo identidade, horário e chave. Ordem JSON de entrada é irrelevante.
export function envelopeHash(envelope: Envelope): string { return createHash('sha256').update(JSON.stringify(envelope)).digest('hex'); }
export class SqsConsumer {
  private stopped = false;
  private nextDatabaseProbeAt = 0;
  private unavailableProbes = 0;
  private readonly tasks = new Set<Promise<number>>();
  private readonly receives = new Set<AbortController>();
  private readonly active = new Set<ActiveMessage>();
  constructor(private readonly sqs: SQSClient, private readonly queueUrl: string,
    private readonly submit: Pick<SubmitWager, 'execute'> & Partial<Pick<SubmitWager, 'recordPermanentFailure'>>,
    private readonly consumerName = 'wagering-transactions',
    private readonly options: ConsumerOptions = {}) {
    stringContract(queueUrl, 2048); stringContract(consumerName, 120);
    if (options.waitTimeSeconds !== undefined && (!Number.isInteger(options.waitTimeSeconds) || options.waitTimeSeconds < 1 || options.waitTimeSeconds > 20)) {
      throw new Error('waitTimeSeconds deve estar entre 1 e 20.');
    }
    const visibility = options.visibilityTimeoutSeconds ?? 30, heartbeat = options.heartbeatMs ?? Math.floor(visibility * 1000 / 3);
    if (!Number.isInteger(visibility) || visibility < 1 || visibility > 43200 || !Number.isInteger(heartbeat) || heartbeat < 1 || heartbeat >= visibility * 1000 / 2) {
      throw new Error('Heartbeat deve renovar antes da metade do prazo de visibilidade.');
    }
    if (options.dlqUrl !== undefined) stringContract(options.dlqUrl, 2048);
    const requestTimeout = options.sqsRequestTimeoutMs ?? 10000, receiveTimeout = options.receiveTimeoutMs ?? ((options.waitTimeSeconds ?? 20) + 5) * 1000;
    if (!Number.isInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 120000 || !Number.isInteger(receiveTimeout)
      || receiveTimeout <= (options.waitTimeSeconds ?? 20) * 1000 || receiveTimeout > 120000) throw new Error('Prazos RPC SQS inválidos');
  }
  pollOnce(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    const task = this.poll(); this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  async stop(graceMs: number): Promise<{ drained: boolean }> {
    this.stopped = true;
    for (const receive of this.receives) receive.abort();
    const drained = await settleWithin([...this.tasks], graceMs);
    if (!drained) await Promise.all([...this.active].map(async state => {
      state.abandoned = true; clearTimeout(state.timer);
      await state.renewal;
      try { await this.visibility(state.receipt, 0); } catch { /* A expiração original ainda permite recuperação. */ }
    }));
    return { drained };
  }
  private async poll(): Promise<number> {
    if (Date.now() < this.nextDatabaseProbeAt) return 0;
    if (this.options.databaseAvailable) {
      let available = false;
      try { available = await this.options.databaseAvailable(); } catch { /* Uma falha na sonda também pausa recebimentos. */ }
      if (!available) {
        this.nextDatabaseProbeAt = Date.now() + retryDelaySeconds(++this.unavailableProbes) * 1000;
        return 0;
      }
      this.unavailableProbes = 0; this.nextDatabaseProbeAt = 0;
    }
    if (this.stopped) return 0;
    const abort = new AbortController(); this.receives.add(abort);
    let response;
    try {
      response = await this.request(signal => this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, WaitTimeSeconds: this.options.waitTimeSeconds ?? 20,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds ?? 30, MaxNumberOfMessages: 1,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'] }), { abortSignal: signal }),
        this.options.receiveTimeoutMs ?? ((this.options.waitTimeSeconds ?? 20) + 5) * 1000, abort);
    } catch (error) { if (this.stopped && abort.signal.aborted) return 0; throw error; }
    finally { this.receives.delete(abort); }
    for (const message of response.Messages ?? []) {
      if (!message.ReceiptHandle) invalid();
      if (this.stopped) { await this.visibility(message.ReceiptHandle, 0); continue; }
      const state: ActiveMessage = { receipt: message.ReceiptHandle, abandoned: false };
      this.active.add(state); this.heartbeat(state);
      try { await this.process(message, state); }
      finally { await this.stopHeartbeat(state); this.active.delete(state); }
    }
    return response.Messages?.length ?? 0;
  }
  private async process(message: Message, state: ActiveMessage): Promise<void> {
    let envelope: Envelope;
    try {
      if (message.Body === undefined) invalid();
      let input: unknown; try { input = JSON.parse(message.Body); } catch { invalid(); }
      envelope = wagerEnvelope(input);
    } catch (error) {
      if (!this.options.dlqUrl || message.Body === undefined || !message.MessageId) throw error;
      // SQS confirma aceitação antes do delete. Crash entre ambos pode duplicar a DLQ;
      // identidade da origem continua estável mesmo após a janela de dedupe FIFO.
      try { await this.sendDlq(message, 'malformed'); }
      catch (failure) { await this.defer(message, state); throw failure; }
      await this.options.afterDlqSendBeforeAck?.(message);
      if (!state.abandoned) await this.ack(state.receipt);
      return;
    }
    const { idempotencyKey, ...payload } = envelope.data;
    const context = { idempotencyKey, correlationId: envelope.messageId, causationId: envelope.messageId,
      inbox: { consumerName: this.consumerName, messageId: envelope.messageId, payloadHash: envelopeHash(envelope), receivedAt: new Date() } };
    let result: ProcessingResponse;
    try {
      result = await this.submit.execute(payload, context);
    } catch (error) {
      if (classifyFailure(error) === 'permanent' && this.submit.recordPermanentFailure) {
        // A primeira SQL já foi revertida. A nova transação confirma FAILED e inbox juntos.
        try { result = await this.submit.recordPermanentFailure(payload, context); }
        catch (failure) { await this.defer(message, state); throw failure; }
      } else {
        await this.defer(message, state);
        throw error;
      }
    }
    await this.options.afterCommitBeforeAck?.(message);
    if (result.status === 'FAILED') {
      try { await this.sendDlq(message, 'permanent'); }
      catch (failure) { await this.defer(message, state); throw failure; }
      await this.options.afterDlqSendBeforeAck?.(message);
    }
    if (!state.abandoned) await this.ack(state.receipt);
  }
  private async sendDlq(message: Message, failureClass: 'malformed' | 'permanent'): Promise<void> {
    if (!this.options.dlqUrl || message.Body === undefined || !message.MessageId) {
      throw new ApplicationError('DLQ_UNAVAILABLE', 'Envio durável à DLQ indisponível; mensagem preservada na origem.', 503);
    }
    const accepted = await this.request(signal => this.sqs.send(new SendMessageCommand({ QueueUrl: this.options.dlqUrl!, MessageBody: message.Body!,
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid-envelope', MessageDeduplicationId: message.MessageId,
      MessageAttributes: { sourceMessageId: { DataType: 'String', StringValue: message.MessageId },
        sourceQueueUrl: { DataType: 'String', StringValue: this.queueUrl }, failureClass: { DataType: 'String', StringValue: failureClass } } }), { abortSignal: signal }));
    if (!accepted.MessageId) throw new ApplicationError('DLQ_UNCONFIRMED', 'DLQ não confirmou aceitação; mensagem preservada na origem.', 503);
  }
  private ack(receipt: string): Promise<unknown> {
    return this.request(signal => this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }), { abortSignal: signal }));
  }
  private async request<T>(send: (signal: AbortSignal) => Promise<T>, milliseconds = this.options.sqsRequestTimeoutMs ?? 10000,
    abort = new AbortController()): Promise<T> {
    const deadline = setTimeout(() => abort.abort(new Error('Prazo RPC SQS excedido')), milliseconds);
    try { return await send(abort.signal); } finally { clearTimeout(deadline); }
  }
  private async stopHeartbeat(state: ActiveMessage): Promise<void> {
    state.heartbeatStopped = true; clearTimeout(state.timer); await state.renewal;
  }
  private async defer(message: Message, state: ActiveMessage): Promise<void> {
    await this.stopHeartbeat(state);
    if (!state.abandoned) {
      try { await this.visibility(state.receipt, retryDelaySeconds(Number(message.Attributes?.ApproximateReceiveCount ?? 1))); }
      catch { /* Sem ack: a expiração permite nova tentativa. */ }
    }
  }
  private async visibility(receipt: string, seconds: number): Promise<void> {
    const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 1000);
    try { await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: seconds }), { abortSignal: abort.signal }); }
    finally { clearTimeout(deadline); }
  }
  private heartbeat(state: ActiveMessage): void {
    state.timer = setTimeout(() => {
      state.renewal = this.visibility(state.receipt, this.options.visibilityTimeoutSeconds ?? 30).catch(() => {}).then(() => {
        if (!state.abandoned && !state.heartbeatStopped && this.active.has(state)) this.heartbeat(state);
      });
    }, this.options.heartbeatMs ?? Math.floor((this.options.visibilityTimeoutSeconds ?? 30) * 1000 / 3));
  }
}

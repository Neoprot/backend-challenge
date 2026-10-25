import { createHash } from 'node:crypto';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { stringContract, wagerContract } from '../shared/application/contracts';
import { ApplicationError } from '../shared/application/application-error';
import type { WagerPayload } from '../wagering/application/canonical-payload';
import type { SubmitWager } from '../wagering/application/submit-wager';

interface Envelope { messageId: string; type: 'WagerTransactionRequested'; occurredAt: string; data: WagerPayload & { idempotencyKey: string }; }
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
  constructor(private readonly sqs: SQSClient, private readonly queueUrl: string, private readonly submit: Pick<SubmitWager, 'execute'>,
    private readonly consumerName = 'wagering-transactions',
    private readonly options: { waitTimeSeconds?: number; afterCommitBeforeAck?: (message: Message) => Promise<void> } = {}) {
    stringContract(queueUrl, 2048); stringContract(consumerName, 120);
    if (options.waitTimeSeconds !== undefined && (!Number.isInteger(options.waitTimeSeconds) || options.waitTimeSeconds < 1 || options.waitTimeSeconds > 20)) {
      throw new Error('waitTimeSeconds deve estar entre 1 e 20.');
    }
  }
  async pollOnce(): Promise<number> {
    const response = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, WaitTimeSeconds: this.options.waitTimeSeconds ?? 20,
      MaxNumberOfMessages: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
    for (const message of response.Messages ?? []) {
      if (message.Body === undefined || !message.ReceiptHandle) invalid();
      let input: unknown;
      try { input = JSON.parse(message.Body); } catch { invalid(); }
      const envelope = wagerEnvelope(input);
      const { idempotencyKey, ...payload } = envelope.data;
      await this.submit.execute(payload, { idempotencyKey, correlationId: envelope.messageId, causationId: envelope.messageId,
        inbox: { consumerName: this.consumerName, messageId: envelope.messageId, payloadHash: envelopeHash(envelope), receivedAt: new Date() } });
      await this.options.afterCommitBeforeAck?.(message);
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    return response.Messages?.length ?? 0;
  }
}

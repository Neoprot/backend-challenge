import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Clock } from '../shared/domain/clock';
import type { Identifiers } from '../shared/domain/identifiers';
import type { OutboxStore } from '../messaging/application/outbox-store';
import type { OutboxMessage } from '../messaging/domain/outbox-message';
import { noObservation, observe, type Observation } from '../shared/application/observation';
import { runWithContext, type ExecutionContext } from '../observability/context';
export interface PublisherOptions { batchSize?: number; leaseMs?: number; sendTimeoutMs?: number; afterSendBeforePublished?: (message: OutboxMessage) => Promise<void>; observation?: Observation; }
export class OutboxPublisher {
  constructor(private readonly store: OutboxStore, private readonly sqs: Pick<SQSClient, 'send'>, private readonly queueUrl: string,
    private readonly ids: Identifiers, private readonly clock?: Clock, private readonly options: PublisherOptions = {}) {
    const batch = options.batchSize ?? 10, lease = options.leaseMs ?? 30000, timeout = options.sendTimeoutMs ?? Math.min(10000, Math.floor(lease / 2));
    if (!Number.isInteger(batch) || batch < 1 || batch > 50 || !Number.isInteger(lease) || lease < 100 || lease > 300000) throw new Error('Lote ou lease fora dos limites');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > Math.floor(lease / 2)) throw new Error('Prazo de envio deve caber na primeira metade do lease');
  }
  async pollOnce(): Promise<number> {
    const owner = this.ids.next(), now = this.clock?.now();
    const messages = await this.store.claim({ limit: this.options.batchSize ?? 10, owner, leaseMs: this.options.leaseMs ?? 30000, ...(now ? { now } : {}) }).catch(error => {
      observe(this.options.observation ?? noObservation, 'worker_failed', { component: 'publisher' }); throw error;
    });
    // Todos os itens iniciam juntos, limitados pelo lote; nenhum aguarda a rede de outro até expirar.
    const outcomes = await Promise.allSettled(messages.map(message => {
      const state = message.snapshot();
      const payload = state.payload && typeof state.payload === 'object' && !Array.isArray(state.payload) ? state.payload : {};
      const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
      const context: ExecutionContext = { correlationId: typeof payload.correlationId === 'string' ? payload.correlationId : state.id, messageId: state.id };
      for (const key of ['transactionId', 'walletId', 'providerId'] as const) if (typeof data[key] === 'string') context[key] = data[key];
      return runWithContext(context, async () => {
        try { return await this.publish(message, owner); }
        catch (error) { observe(this.options.observation ?? noObservation, 'worker_failed', { component: 'publisher' }); throw error; }
      });
    }));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value).length;
  }
  private async publish(message: OutboxMessage, owner: string): Promise<boolean> {
    const state = message.snapshot();
    const started = performance.now();
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new Error('Prazo de envio da outbox excedido')),
      this.options.sendTimeoutMs ?? Math.min(10000, Math.floor((this.options.leaseMs ?? 30000) / 2)));
    try {
      await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageGroupId: state.aggregateId, MessageDeduplicationId: state.id,
        MessageBody: JSON.stringify(state.payload) }), { abortSignal: abort.signal });
    } catch {
      await this.store.fail(state.id, owner, this.clock?.now());
      observe(this.options.observation ?? noObservation, 'worker_failed', { component: 'publisher' });
      observe(this.options.observation ?? noObservation, 'retry', { component: 'publisher' });
      return false;
    } finally {
      clearTimeout(deadline);
    }
    // Falha após envio/SQL não desfaz claim: o lease permite nova entrega com o mesmo eventId.
    await this.options.afterSendBeforePublished?.(message);
    const published = await this.store.markPublished(state.id, owner, this.clock?.now());
    if (published) observe(this.options.observation ?? noObservation, 'outbox_published', { component: 'publisher', durationSeconds: (performance.now() - started) / 1000 });
    return published;
  }
}

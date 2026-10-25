import type { Clock } from '../shared/domain/clock';
import type { Identifiers } from '../shared/domain/identifiers';
import { settleWithin } from './worker-lifecycle';
import type { ReferenceStore, ReferenceProcessor } from '../wagering/application/reference-store';
import { noObservation, observe, type Observation } from '../shared/application/observation';
import { runWithContext } from '../observability/context';
export class ReferenceWorker {
  private stopping = false;
  private readonly active = new Set<Promise<number>>();
  constructor(private readonly store: ReferenceStore, private readonly processor: ReferenceProcessor,
    private readonly ids: Identifiers, private readonly clock?: Clock,
    private readonly options: { batchSize?: number; leaseMs?: number; ids?: readonly string[]; observation?: Observation } = {}) {
    const batch = options.batchSize ?? 10, lease = options.leaseMs ?? 30000;
    if (!Number.isInteger(batch) || batch < 1 || batch > 50 || !Number.isInteger(lease) || lease < 100 || lease > 300000) throw new Error('Lote ou lease fora dos limites.');
  }
  async pollOnce(): Promise<number> {
    if (this.stopping) return 0;
    const running = this.poll(); this.active.add(running);
    try { return await running; } finally { this.active.delete(running); }
  }
  async stop(graceMs: number): Promise<{ drained: boolean }> {
    this.stopping = true; return { drained: await settleWithin([...this.active], graceMs) };
  }
  private async poll(): Promise<number> {
    const owner = this.ids.next(), clock = this.clock, now = clock?.now();
    const claims = await this.store.claim({ owner, limit: this.options.batchSize ?? 10, leaseMs: this.options.leaseMs ?? 30000,
      ...(now === undefined ? {} : { now }), ...(this.options.ids === undefined ? {} : { ids: this.options.ids }) }).catch(error => {
      observe(this.options.observation ?? noObservation, 'worker_failed', { component: 'reference' }); throw error;
    });
    const outcomes = await Promise.allSettled(claims.map(id => runWithContext({ correlationId: id, transactionId: id }, async () => {
      try { await this.processor.reprocessPending(id, owner, clock === undefined ? undefined : () => clock.now()); }
      catch (error) {
        observe(this.options.observation ?? noObservation, 'worker_failed', { component: 'reference' });
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (['55P03', '40P01', '40001'].includes(String(code))) observe(this.options.observation ?? noObservation, 'lock_conflict', { component: 'reference' });
        observe(this.options.observation ?? noObservation, 'retry', { component: 'reference' });
        throw error;
      }
    })));
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return claims.length;
  }
}

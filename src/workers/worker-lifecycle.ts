import { DomainError } from '../shared/domain/domain-error';
import { ApplicationError } from '../shared/application/application-error';
import { isTransientFailure } from '../shared/application/transient-failure';

export type FailureClassification = 'business' | 'transient' | 'permanent';
export function classifyFailure(error: unknown): FailureClassification {
  if (isTransientFailure(error) || error instanceof ApplicationError && error.httpStatus >= 500) return 'transient';
  if (error instanceof DomainError) return 'business';
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^(22|23|42)[A-Z0-9]{3}$/u.test(code)) return 'permanent';
  // Falha desconhecida não prova rejeição de negócio nem permite persistir FAILED.
  return 'transient';
}
export function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(9, Math.max(0, Number.isFinite(attempt) ? Math.floor(attempt) - 1 : 9)));
}
export async function settleWithin(tasks: readonly Promise<unknown>[], graceMs: number): Promise<boolean> {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('Prazo de drain inválido');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.allSettled(tasks).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
  } finally { clearTimeout(timer); }
}

export interface PollingWorker { pollOnce(): Promise<number>; stop?(graceMs: number): Promise<{ drained: boolean }>; }
export interface LifecycleOptions { idleMs?: number; errorBackoffMs?: number; onError?: (error: unknown) => void; }
/** Um supervisor por processo; os locks/leases distribuídos continuam no PostgreSQL/SQS. */
export class WorkerLifecycle {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private readonly wake = new AbortController();
  constructor(private readonly workers: readonly PollingWorker[], private readonly options: LifecycleOptions = {}) {
    for (const value of [options.idleMs ?? 100, options.errorBackoffMs ?? 1000]) {
      if (!Number.isFinite(value) || value < 1) throw new Error('Intervalo do supervisor inválido');
    }
  }
  start(): void {
    if (this.loops.length || this.stopping) throw new Error('Supervisor já iniciado ou encerrado');
    this.loops = this.workers.map(worker => this.loop(worker));
  }
  async stop(graceMs: number): Promise<{ drained: boolean }> {
    this.stopping = true; this.wake.abort();
    const stops = this.workers.map(worker => worker.stop?.(graceMs));
    const drained = await settleWithin(this.loops, graceMs);
    const outcomes = await Promise.all(stops);
    return { drained: drained && outcomes.every(result => result?.drained !== false) };
  }
  private async loop(worker: PollingWorker): Promise<void> {
    while (!this.stopping) {
      let pause = this.options.idleMs ?? 100;
      try { if (await worker.pollOnce()) pause = 0; }
      catch (error) { this.options.onError?.(error); pause = this.options.errorBackoffMs ?? 1000; }
      if (pause && !this.stopping) await new Promise<void>(resolve => {
        const complete = () => { clearTimeout(timer); this.wake.signal.removeEventListener('abort', complete); resolve(); };
        const timer = setTimeout(complete, pause); this.wake.signal.addEventListener('abort', complete, { once: true });
        if (this.wake.signal.aborted) complete();
      });
    }
  }
}

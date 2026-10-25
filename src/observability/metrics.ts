import type { WagerTransactionStatus as Status, WagerTransactionKind as Kind } from '../wagering/domain/wager-transaction';
export type Component = 'submit' | 'opening' | 'reference' | 'consumer' | 'publisher' | 'http' | 'reconciliation';
const components: readonly Component[] = ['submit', 'opening', 'reference', 'consumer', 'publisher', 'http', 'reconciliation'];
const statuses: readonly Status[] = ['PENDING', 'PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'];
const kinds: readonly Kind[] = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
function bounded<T extends string>(value: T, choices: readonly T[]): void { if (!choices.includes(value)) throw new Error('Label de métrica fora da enumeração'); }
/** Contadores em memória por processo; não constituem contagem global ou garantia de idempotência. */
export class Metrics {
  private readonly values = new Map<string, number>();
  private lag: number | undefined;
  private add(key: string, value = 1): void { this.values.set(key, (this.values.get(key) ?? 0) + value); }
  transaction(status: Status, kind: Kind, replay: boolean, seconds?: number, component: Component = 'submit'): void {
    bounded(status, statuses); bounded(kind, kinds);
    if (replay) this.add('wagering_duplicates_total');
    else this.add(`wagering_transactions_total{status="${status}",kind="${kind}"}`);
    if (seconds !== undefined) this.latency(component, seconds);
  }
  retry(component: Component): void { bounded(component, components); this.add(`wagering_retries_total{component="${component}"}`); }
  lockConflict(component: Component): void { bounded(component, components); this.add(`wagering_lock_conflicts_total{component="${component}"}`); }
  dlq(failureClass: 'malformed' | 'permanent'): void { bounded(failureClass, ['malformed', 'permanent']); this.add(`wagering_dlq_total{failure_class="${failureClass}"}`); }
  reconciliation(consistent: boolean): void { if (!consistent) this.add('wagering_reconciliation_divergences_total'); }
  latency(component: Component, seconds: number): void {
    bounded(component, components); if (!Number.isFinite(seconds) || seconds < 0) return;
    this.add(`wagering_duration_seconds_sum{component="${component}"}`, seconds);
    this.add(`wagering_duration_seconds_count{component="${component}"}`);
  }
  setOutboxLag(seconds: number): void { if (Number.isFinite(seconds) && seconds >= 0) this.lag = seconds; }
  render(): string {
    const lines = [
      '# HELP wagering_transactions_total Transições confirmadas neste processo.', '# TYPE wagering_transactions_total counter',
      '# TYPE wagering_duplicates_total counter', '# TYPE wagering_retries_total counter', '# TYPE wagering_dlq_total counter',
      '# TYPE wagering_lock_conflicts_total counter', '# TYPE wagering_reconciliation_divergences_total counter',
      '# TYPE wagering_duration_seconds summary', '# TYPE wagering_outbox_lag_seconds gauge',
      '# HELP wagering_outbox_lag_seconds Idade da outbox não publicada mais antiga; última leitura válida.',
    ];
    for (const [key, value] of [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${key} ${value}`);
    if (this.lag !== undefined) lines.push(`wagering_outbox_lag_seconds ${this.lag}`);
    return lines.join('\n') + '\n';
  }
}

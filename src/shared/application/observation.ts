/** Porta de saída: observação nunca participa da decisão ou da transação financeira. */
export type ObservationEvent = 'transaction_committed' | 'duplicate' | 'retry' | 'lock_conflict' | 'dlq_accepted'
  | 'reconciliation_divergence' | 'reconciliation_checked' | 'http_completed' | 'worker_failed' | 'message_completed' | 'outbox_published';
export interface ExecutionIdentifiers { correlationId?: string; messageId?: string; transactionId?: string; walletId?: string; providerId?: string; }
export interface Observation {
  record(event: ObservationEvent, metadata?: Record<string, unknown>): void;
  executionContext?(identifiers: ExecutionIdentifiers): void;
}
export const noObservation: Observation = { record: () => {} };
export function observe(observer: Observation, event: ObservationEvent, metadata: Record<string, unknown> = {}): void {
  try { observer.record(event, metadata); } catch { /* Telemetria indisponível não muda commits nem provoca retries financeiros. */ }
}
export function observeContext(observer: Observation, identifiers: ExecutionIdentifiers): void {
  try { observer.executionContext?.(identifiers); } catch { /* Enriquecer diagnósticos não altera a execução. */ }
}

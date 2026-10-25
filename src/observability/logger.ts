import type { ObservationEvent } from '../shared/application/observation';
import { currentContext, sanitizeContext } from './context';
export type LogSink = (line: string) => void;
const events: readonly ObservationEvent[] = ['transaction_committed', 'duplicate', 'retry', 'lock_conflict', 'dlq_accepted',
  'reconciliation_divergence', 'reconciliation_checked', 'http_completed', 'worker_failed', 'message_completed', 'outbox_published'];
const statuses = ['PENDING', 'PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'];
const kinds = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
const components = ['submit', 'opening', 'reference', 'consumer', 'publisher', 'http', 'reconciliation'];
/** Lista positiva: objetos, erros/SQL, headers, bodies e valores monetários jamais são serializados. */
export class StructuredLogger {
  constructor(private readonly sink: LogSink = line => { console.log(line); }) {}
  write(event: ObservationEvent, metadata: Record<string, unknown> = {}): void {
    try {
      if (!events.includes(event)) return;
      const record: Record<string, unknown> = { timestamp: new Date().toISOString(), level: event === 'worker_failed' ? 'error' : 'info', event,
        ...currentContext(), ...sanitizeContext(metadata) };
      for (const [key, allowed] of [['status', statuses], ['kind', kinds], ['component', components], ['failureClass', ['malformed', 'permanent']]] as const) {
        if (typeof metadata[key] === 'string' && allowed.includes(metadata[key] as never)) record[key] = metadata[key];
      }
      if (typeof metadata.httpStatus === 'number' && Number.isInteger(metadata.httpStatus) && metadata.httpStatus >= 100 && metadata.httpStatus <= 599) record.httpStatus = metadata.httpStatus;
      if (typeof metadata.durationSeconds === 'number' && Number.isFinite(metadata.durationSeconds) && metadata.durationSeconds >= 0) record.durationSeconds = metadata.durationSeconds;
      this.sink(JSON.stringify(record));
    } catch { /* O sink é best effort e não pode alterar a execução. */ }
  }
}

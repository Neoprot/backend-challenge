import type { Observation, ObservationEvent, ExecutionIdentifiers } from '../shared/application/observation';
import { StructuredLogger } from './logger';
import { Metrics, type Component } from './metrics';
import { enrichContext } from './context';
export class ApplicationObservation implements Observation {
  constructor(readonly logger = new StructuredLogger(), readonly metrics = new Metrics()) {}
  executionContext(identifiers: ExecutionIdentifiers): void { enrichContext(identifiers); }
  record(event: ObservationEvent, metadata: Record<string, unknown> = {}): void {
    this.logger.write(event, metadata);
    const component = metadata.component as Component;
    switch (event) {
      case 'transaction_committed': case 'duplicate':
        this.metrics.transaction(metadata.status as never, metadata.kind as never, event === 'duplicate',
          typeof metadata.durationSeconds === 'number' ? metadata.durationSeconds : undefined, component); return;
      case 'retry': this.metrics.retry(component); break;
      case 'lock_conflict': this.metrics.lockConflict(component); break;
      case 'dlq_accepted': this.metrics.dlq(metadata.failureClass as never); break;
      case 'reconciliation_divergence': this.metrics.reconciliation(false); break;
    }
    if (typeof metadata.durationSeconds === 'number') this.metrics.latency(component, metadata.durationSeconds);
  }
}

import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SubmitWager } from '../wagering/application/submit-wager';
import { WorkerLifecycle } from './worker-lifecycle';
import { SqsConsumer } from './sqs-consumer';
import { OutboxPublisher } from './outbox-publisher';
import { PostgresOutboxStore } from '../persistence/outbox-store';
import { UuidIdentifiers } from '../shared/domain/identifiers';
export interface WorkerConfiguration {
  requestQueueUrl: string; requestDlqUrl: string; eventQueueUrl: string; consumerName: string;
  visibilityTimeoutSeconds: number; heartbeatMs: number; shutdownGraceMs: number;
}
export function readWorkerConfiguration(environment: Record<string, string | undefined>): WorkerConfiguration {
  const queue = (key: string): string => {
    const value = environment[key];
    if (!value) throw new Error(`${key} obrigatória para o runtime de workers`);
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${key} inválida`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.pathname.endsWith('.fifo') || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${key} deve identificar uma fila FIFO`);
    }
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = environment[key] ?? String(fallback), value = Number(raw);
    if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} fora dos limites`);
    return value;
  };
  const requestQueueUrl = queue('REQUEST_QUEUE_URL'), requestDlqUrl = queue('REQUEST_DLQ_URL'), eventQueueUrl = queue('EVENT_QUEUE_URL');
  if (new Set([requestQueueUrl, requestDlqUrl, eventQueueUrl]).size !== 3) throw new Error('Filas de entrada, DLQ e saída devem ser distintas');
  const visibilityTimeoutSeconds = integer('WORKER_VISIBILITY_SECONDS', 30, 1, 43200);
  const heartbeatMs = integer('WORKER_HEARTBEAT_MS', Math.floor(visibilityTimeoutSeconds * 1000 / 3), 1, Math.ceil(visibilityTimeoutSeconds * 500) - 1);
  const consumerName = environment.WORKER_CONSUMER_NAME ?? 'wagering-transactions';
  if (!consumerName.trim() || consumerName.length > 120) throw new Error('WORKER_CONSUMER_NAME inválido');
  return { requestQueueUrl, requestDlqUrl, eventQueueUrl, consumerName, visibilityTimeoutSeconds, heartbeatMs,
    shutdownGraceMs: integer('WORKER_SHUTDOWN_GRACE_MS', 25000, 100, 300000) };
}
export function createWorkerRuntime(configuration: WorkerConfiguration, orm: MikroORM, sqs: SQSClient, submit: SubmitWager): WorkerLifecycle {
  const consumer = new SqsConsumer(sqs, configuration.requestQueueUrl, submit, configuration.consumerName, {
    dlqUrl: configuration.requestDlqUrl, visibilityTimeoutSeconds: configuration.visibilityTimeoutSeconds, heartbeatMs: configuration.heartbeatMs,
    databaseAvailable: async () => {
      try { await orm.em.fork().execute('select 1'); return true; } catch { return false; }
    },
  });
  const publisher = new OutboxPublisher(new PostgresOutboxStore(orm), sqs, configuration.eventQueueUrl, new UuidIdentifiers());
  return new WorkerLifecycle([consumer, publisher], { onError: () => { console.error('Worker indisponível; nova tentativa será agendada.'); } });
}

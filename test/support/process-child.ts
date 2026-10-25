// Controles exclusivos do harness por IPC; não são endpoints ou flags de produção.
import { createApplication } from '../../src/bootstrap/main';
import { createOrm } from '../../src/persistence/orm';
import { SQSClient } from '@aws-sdk/client-sqs';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import { PostgresOutboxStore } from '../../src/persistence/outbox-store';
import { testEnvironment } from './environment';
import type { OutboxStore } from '../../src/messaging/application/outbox-store';
import type { HarnessCommand } from './processes';

export async function runHarnessChild(beforeStartup: () => Promise<void> = async () => {}): Promise<void> {
  // A perda do supervisor também pode ocorrer durante imports ou antes da primeira conexão.
  process.on('disconnect', () => process.exit(0));
  if (!process.connected) process.exit(0);
  await beforeStartup();
  const env = testEnvironment();
  const app = await createApplication({ ...env, audience: 'wagering-api', port: 3000, region: 'us-east-1' }, { logSink: () => {} });
  const orm = await createOrm(env.databaseUrl);
  const ids = new UuidIdentifiers(), clock = { now: () => new Date() };
  const submit = new SubmitWager(new PostgresUnitOfWork(orm), clock, ids);
  const sqs = new SQSClient({ endpoint: env.sqsEndpoint, region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const releases = new Map<string, () => void>();
  async function hold(id: string, stage: string, entityId?: string): Promise<void> {
    const gate = new Promise<void>(resolve => releases.set(id, resolve));
    process.send!({ type: 'stage', requestId: id, stage, entityId });
    await gate; releases.delete(id);
  }
  process.on('message', (raw: unknown) => {
    const command = raw as HarnessCommand;
    if (command.action === 'release') { releases.get(command.requestId)?.(); return; }
    void (async () => {
      if (command.action === 'consumer') {
        const consumer = new SqsConsumer(sqs, command.queueUrl, submit, command.consumerName, {
          waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, heartbeatMs: 400,
          afterCommitBeforeAck: async message => {
            const count = message.Attributes?.ApproximateReceiveCount;
            if (command.hold) await hold(command.requestId, 'committed', count);
            else process.send!({ type: 'stage', requestId: command.requestId, stage: 'committed', entityId: count });
          },
        });
        return consumer.pollOnce();
      }
      const base = new PostgresOutboxStore(orm);
      const store: OutboxStore = { claim: options => base.claim({ ...options, ids: command.ids }),
        markPublished: (...args) => base.markPublished(...args), fail: (...args) => base.fail(...args) };
      return new OutboxPublisher(store, sqs, command.queueUrl, ids, undefined, { batchSize: 1, leaseMs: command.leaseMs ?? 10000,
        ...(command.hold ? { afterSendBeforePublished: message => hold(command.requestId, 'sent', message.snapshot().id) } : {}),
      }).pollOnce();
    })().then(value => process.send!({ type: 'result', requestId: command.requestId, value }),
      () => process.send!({ type: 'failure', requestId: command.requestId }));
  });
  await app.listen(0, '127.0.0.1');
  const databasePid = (await orm.em.fork().execute<{ pid: number }[]>('select pg_backend_pid() as pid'))[0]!.pid;
  process.send!({ type: 'ready', pid: process.pid, databasePid, base: await app.getUrl() });
}
if (import.meta.main) await runHarnessChild();

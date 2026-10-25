import { afterAll, beforeAll, expect, test } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, ChangeMessageVisibilityCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { InboxRecord, LedgerRecord, WagerRecord, WalletRecord } from '../../src/persistence/records';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { inboxFixture } from '../support/inbox-fixture';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
import { prepareLinuxRuntime, startLinuxRuntime } from '../support/linux-runtime';

let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  await prepareLinuxRuntime(); orm = await createOrm(env.databaseUrl);
}, 180000);
afterAll(async () => { await orm?.close(true); });

async function until(check: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20); }
  throw new Error('Sinal esperado não chegou no prazo.');
}

for (const graceful of [true, false]) test(`SIGTERM Linux ${graceful ? 'drena a operação e sai com zero' : 'encerra no prazo e permite retomada sem efeito parcial'}`, async () => {
  const fixture = await inboxFixture(orm), queues: string[] = [];
  let runtime: Awaited<ReturnType<typeof startLinuxRuntime>> | undefined;
  let release = () => {}, blocker: Promise<void> | undefined;
  try {
    for (const suffix of ['dlq', 'events']) {
      const queue = await fixture.sqs.send(new CreateQueueCommand({ QueueName: `signal-${fixture.ids.next()}-${suffix}.fifo`, Attributes: { FifoQueue: 'true' } }));
      if (!queue.QueueUrl) throw new Error('Fila exclusiva não foi criada.'); queues.push(queue.QueueUrl);
    }
    runtime = await startLinuxRuntime({ request: fixture.queueUrl, dlq: queues[0]!, events: queues[1]! }, graceful ? 15000 : 1000);
    const application = runtime;
    let locked!: () => void, blockerPid = 0;
    const lockedSignal = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    blocker = orm.em.fork().transactional(async em => {
      await em.findOneOrFail(WalletRecord, { id: fixture.wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      blockerPid = (await em.execute<{ pid: number }[]>('select pg_backend_pid() as pid'))[0]!.pid;
      locked(); await held;
    });
    await Promise.race([lockedSignal, blocker.then(() => { throw new Error('Bloqueador encerrou antes do sinal.'); })]);
    await fixture.send();
    // A atividade PostgreSQL comprova uma operação real aguardando esta carteira.
    await until(async () => (await orm.em.fork().execute<{ count: string }[]>(
      'select count(*)::text as count from pg_stat_activity where host(client_addr) = ? and ? = any(pg_blocking_pids(pid))',
      [application.address, blockerPid]))[0]!.count !== '0');
    const signaledAt = performance.now();
    await application.signal();
    if (graceful) {
      expect((await application.inspect()).State.Running).toBe(true);
      const second = { ...fixture.envelope, messageId: fixture.ids.next(), data: { ...fixture.envelope.data,
        externalTransactionId: fixture.ids.next(), idempotencyKey: fixture.ids.next() } };
      await fixture.sqs.send(new SendMessageCommand({ QueueUrl: fixture.queueUrl, MessageBody: JSON.stringify(second),
        MessageGroupId: `second-${fixture.wallet.id}`, MessageDeduplicationId: second.messageId }));
      release(); await blocker;
      await until(async () => !(await application.inspect()).State.Running, 20000);
      expect((await application.inspect()).State.ExitCode).toBe(0);
      expect(await orm.em.fork().count(InboxRecord, { consumerName: application.consumerName, messageId: fixture.envelope.messageId })).toBe(1);
      expect(await orm.em.fork().count(WagerRecord, { providerId: 'aurora', externalTransactionId: second.data.externalTransactionId })).toBe(0);
      const remaining = await fixture.sqs.send(new ReceiveMessageCommand({ QueueUrl: fixture.queueUrl, WaitTimeSeconds: 0, MaxNumberOfMessages: 10 }));
      expect(remaining.Messages).toHaveLength(1);
      expect(JSON.parse(remaining.Messages![0]!.Body!).messageId).toBe(second.messageId);
    } else {
      await until(async () => !(await application.inspect()).State.Running, 6000);
      // A margem cobre a observação pela CLI Docker, além do watchdog de 1 s.
      expect(performance.now() - signaledAt).toBeLessThan(3500);
      expect((await application.inspect()).State.ExitCode).toBe(1);
      expect(await orm.em.fork().count(WagerRecord, { providerId: 'aurora', externalTransactionId: fixture.envelope.data.externalTransactionId })).toBe(0);
      expect(await orm.em.fork().count(InboxRecord, { consumerName: application.consumerName, messageId: fixture.envelope.messageId })).toBe(0);
      expect((await orm.em.fork().findOneOrFail(WalletRecord, { id: fixture.wallet.id })).balance).toBe('100.00');
      release(); await blocker;
      const redelivery = await fixture.sqs.send(new ReceiveMessageCommand({ QueueUrl: fixture.queueUrl, WaitTimeSeconds: 0,
        VisibilityTimeout: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
      expect(redelivery.Messages).toHaveLength(1);
      expect(Number(redelivery.Messages![0]!.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(2);
      await fixture.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: fixture.queueUrl,
        ReceiptHandle: redelivery.Messages![0]!.ReceiptHandle!, VisibilityTimeout: 0 }));
      const restarted = new SqsConsumer(fixture.sqs, fixture.queueUrl, fixture.submit, application.consumerName, { waitTimeSeconds: 1, visibilityTimeoutSeconds: 2 });
      try { expect(await restarted.pollOnce()).toBe(1); } finally { await restarted.stop(1000); }
    }
    const transaction = await orm.em.fork().findOneOrFail(WagerRecord, { providerId: 'aurora', externalTransactionId: fixture.envelope.data.externalTransactionId });
    expect(transaction.status).toBe('PROCESSED');
    expect(await orm.em.fork().count(LedgerRecord, { transactionId: transaction.id })).toBe(1);
    expect((await orm.em.fork().findOneOrFail(WalletRecord, { id: fixture.wallet.id })).balance).toBe('75.00');
    await assertLedger(orm, fixture.wallet.id);
    expect((await orm.em.fork().execute<{ count: string }[]>(
      'select count(*)::text as count from pg_stat_activity where host(client_addr) = ? and usename = current_user', [application.address]))[0]!.count).toBe('0');
  } catch (error) {
    const logs = runtime ? await runtime.logs().catch(() => '') : '';
    throw new Error(`Aceite SIGTERM Linux falhou. ${logs.slice(-4000)}`, { cause: error });
  } finally {
    release();
    try { await blocker; }
    finally {
      try { await runtime?.close(); }
      finally {
        const cleanup = await Promise.allSettled(queues.map(queue => fixture.sqs.send(new DeleteQueueCommand({ QueueUrl: queue }))));
        await fixture.close();
        const failed = cleanup.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
    }
  }
}, 60000);

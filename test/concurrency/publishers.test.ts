import { beforeAll, afterAll, test, expect } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { OutboxRecord } from '../../src/persistence/records';
import { PostgresOutboxStore } from '../../src/persistence/outbox-store';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import type { OutboxStore } from '../../src/messaging/application/outbox-store';
import { inboxFixture } from '../support/inbox-fixture';
import { testEnvironment } from '../support/environment';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
test('dois publishers ultrapassam row lock com SKIP LOCKED sem disputar lease ativo', async () => {
  const first = await inboxFixture(orm), second = await inboxFixture(orm), base = new PostgresOutboxStore(orm);
  const rows = await orm.em.fork().find(OutboxRecord, { aggregateId: { $in: [first.wallet.id, second.wallet.id] } });
  const ids = rows.map(row => row.id), lockedId = ids[0]!;
  const store: OutboxStore = { claim: options => base.claim({ ...options, ids }), markPublished: (...args) => base.markPublished(...args), fail: (...args) => base.fail(...args) };
  let unlock!: () => void, locked!: () => void, resume!: () => void, sent!: () => void;
  const heldLock = new Promise<void>(resolve => { unlock = resolve; }), lockAcquired = new Promise<void>(resolve => { locked = resolve; });
  const heldSend = new Promise<void>(resolve => { resume = resolve; }), sendReached = new Promise<void>(resolve => { sent = resolve; });
  const blocker = orm.em.fork().transactional(async em => {
    await em.execute('select id from outbox_message where id = ? for update', [lockedId]); locked(); await heldLock;
  });
  let running: Promise<number> | undefined;
  try {
    await lockAcquired;
    const publisher = new OutboxPublisher(store, first.sqs, first.queueUrl, first.ids, undefined, { batchSize: 1,
      afterSendBeforePublished: async event => { expect(event.snapshot().id).not.toBe(lockedId); sent(); await heldSend; } });
    running = publisher.pollOnce(); await sendReached;
    const other = new OutboxPublisher(store, first.sqs, first.queueUrl, second.ids, undefined, { batchSize: 1 });
    expect(await other.pollOnce()).toBe(0);
    unlock(); await blocker;
    expect(await other.pollOnce()).toBe(1);
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { id: lockedId })).publishedAt).not.toBeNull();
    resume(); expect(await running).toBe(1);
    expect(await orm.em.fork().count(OutboxRecord, { id: { $in: ids }, publishedAt: { $ne: null } })).toBe(2);
    const received = await first.sqs.send(new ReceiveMessageCommand({ QueueUrl: first.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    expect(new Set(received.Messages?.map(message => JSON.parse(message.Body!).eventId))).toEqual(new Set(ids));
  } finally { unlock(); resume(); await blocker; await running; await first.close(); await second.close(); }
}, 15000);
// Morte de processo SO e harness de restart/drain ficam para a tarefa 18.

import { beforeAll, afterAll, test, expect } from 'bun:test';
import { ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { PostgresOutboxStore } from '../../src/persistence/outbox-store';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import { InboxRecord, OutboxRecord } from '../../src/persistence/records';
import { PostgresIntegrationEventInbox } from '../../src/persistence/integration-event-inbox';
import { IntegrationEventConsumer } from '../../src/workers/integration-event-consumer';
import type { OutboxStore } from '../../src/messaging/application/outbox-store';
import { inboxFixture } from '../support/inbox-fixture';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
async function fixture() {
  const f = await inboxFixture(orm), base = new PostgresOutboxStore(orm);
  const records = await orm.em.fork().find(OutboxRecord, { aggregateId: f.wallet.id });
  const eventIds = records.map(row => row.id);
  const store: OutboxStore = { claim: options => base.claim({ ...options, ids: eventIds }), markPublished: (...args) => base.markPublished(...args), fail: (...args) => base.fail(...args) };
  return { ...f, store, base, eventId: eventIds[0]!, eventIds };
}
test('evento confirmado sobrevive à troca de instância e claim é commitado antes da rede', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const sent = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  let time = new Date(), staleOwner = '', running: Promise<number> | undefined;
  try {
    expect(f.eventIds.length).toBeGreaterThan(0);
    const clock = { now: () => new Date(time) };
    const first = new OutboxPublisher(f.store, f.sqs, f.queueUrl, { next: () => (staleOwner = crypto.randomUUID()) }, clock,
      { batchSize: 1, leaseMs: 1000, afterSendBeforePublished: async () => { entered(); await hold; } });
    const claimed = await f.base.claim({ limit: 1, owner: crypto.randomUUID(), leaseMs: 1000, now: time, ids: f.eventIds });
    expect(claimed).toHaveLength(1);
    time = new Date(time.getTime() + 1001);
    running = first.pollOnce(); await sent;
    const row = await orm.em.fork().findOneOrFail(OutboxRecord, { id: f.eventId });
    expect(row.leaseOwner).toBe(staleOwner); expect(row.publishedAt).toBeNull();
    // NOWAIT em outra conexão comprova ausência de lock SQL durante o hook de rede.
    await orm.em.fork().transactional(async em => { await em.execute('select id from outbox_message where id = ? for update nowait', [f.eventId]); });
    expect(await f.store.markPublished(f.eventId, crypto.randomUUID(), time)).toBe(false);
    expect(await f.store.fail(f.eventId, crypto.randomUUID(), time)).toBe(false);
    time = new Date(time.getTime() + 1001);
    expect(await f.store.markPublished(f.eventId, staleOwner, time)).toBe(false);
    expect(await f.store.fail(f.eventId, staleOwner, time)).toBe(false);
    const second = new OutboxPublisher(f.store, f.sqs, f.queueUrl, f.ids, clock, { batchSize: 1, leaseMs: 1000 });
    expect(await second.pollOnce()).toBe(1);
    expect(await f.store.markPublished(f.eventId, staleOwner, time)).toBe(false);
    release(); expect(await running).toBe(0);
    const recovered = await orm.em.fork().findOneOrFail(OutboxRecord, { id: f.eventId });
    expect(recovered.publishedAt).not.toBeNull(); expect(recovered.leaseOwner).toBeNull();
    expect(recovered.attempts).toBe(0);
    const received = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    expect(received.Messages).toHaveLength(1); expect(JSON.parse(received.Messages![0]!.Body!).eventId).toBe(f.eventId);
    expect(JSON.parse(received.Messages![0]!.Body!)).toEqual(recovered.payload);
    expect(await orm.em.fork().count(OutboxRecord, { id: f.eventId })).toBe(1); await assertLedger(orm, f.wallet.id);
  } finally { release?.(); await running; await f.close(); }
}, 15000);
test('consumidor demonstrativo persiste eventId e ignora duplicata após janela FIFO simulada', async () => {
  const f = await fixture(), consumerName = `integration-${crypto.randomUUID()}`;
  try {
    const publisher = new OutboxPublisher(f.store, f.sqs, f.queueUrl, f.ids);
    expect(await publisher.pollOnce()).toBe(1);
    const consumer = new IntegrationEventConsumer(f.sqs, f.queueUrl, new PostgresIntegrationEventInbox(orm, consumerName));
    expect(await consumer.pollOnce()).toBe(1);
    const record = await orm.em.fork().findOneOrFail(OutboxRecord, { id: f.eventId });
    const body = record.payload;
    // Outro dedupId SOMENTE no harness representa redelivery além dos cinco minutos do broker.
    await f.sqs.send(new SendMessageCommand({ QueueUrl: f.queueUrl, MessageGroupId: record.aggregateId, MessageDeduplicationId: crypto.randomUUID(), MessageBody: JSON.stringify(body) }));
    const restarted = new IntegrationEventConsumer(f.sqs, f.queueUrl, new PostgresIntegrationEventInbox(orm, consumerName));
    expect(await restarted.pollOnce()).toBe(0);
    expect(await orm.em.fork().count(InboxRecord, { consumerName, messageId: f.eventId })).toBe(1);
    expect((await orm.em.fork().findOneOrFail(InboxRecord, { consumerName, messageId: f.eventId })).processedAt).not.toBeNull();
    const conflicting = { ...(body as Record<string, unknown>), eventType: 'OtherEvent' };
    await f.sqs.send(new SendMessageCommand({ QueueUrl: f.queueUrl, MessageGroupId: record.aggregateId, MessageDeduplicationId: crypto.randomUUID(), MessageBody: JSON.stringify(conflicting) }));
    let caught: unknown; try { await restarted.pollOnce(); } catch (error) { caught = error; }
    expect((caught as { code: string }).code).toBe('INBOX_PAYLOAD_CONFLICT');
    expect(await orm.em.fork().count(InboxRecord, { consumerName })).toBe(1);
  } finally { await f.close(); }
}, 15000);
test('SQS indisponível preserva evento e retry due recupera com o mesmo eventId', async () => {
  const f = await fixture(); let time = new Date(); const clock = { now: () => new Date(time) };
  const unavailable = new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  try {
    const broken = new OutboxPublisher(f.store, unavailable, 'http://127.0.0.1:1/queue.fifo', { next: () => crypto.randomUUID() }, clock, { batchSize: 1 });
    expect(await broken.pollOnce()).toBe(0);
    const failed = await orm.em.fork().findOneOrFail(OutboxRecord, { id: f.eventId });
    expect(failed.attempts).toBe(1); expect(failed.publishedAt).toBeNull(); expect(failed.leaseOwner).toBeNull();
    expect(failed.nextAttemptAt).toEqual(new Date(time.getTime() + 1000));
    const recovered = new OutboxPublisher(f.store, f.sqs, f.queueUrl, { next: () => crypto.randomUUID() }, clock, { batchSize: 1 });
    expect(await recovered.pollOnce()).toBe(0); time = new Date(time.getTime() + 1000);
    expect(await recovered.pollOnce()).toBe(1);
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { id: f.eventId })).publishedAt).not.toBeNull();
    const received = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
    expect(JSON.parse(received.Messages![0]!.Body!)).toEqual(failed.payload);
    expect(await recovered.pollOnce()).toBe(0);
    await assertLedger(orm, f.wallet.id);
  } finally { unavailable.destroy(); await f.close(); }
}, 15000);

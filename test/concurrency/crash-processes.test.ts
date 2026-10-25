import { beforeAll, afterAll, expect, test } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { InboxRecord, LedgerRecord, OutboxRecord, WagerRecord, WalletRecord } from '../../src/persistence/records';
import { testEnvironment } from '../support/environment';
import { inboxFixture } from '../support/inbox-fixture';
import { ProcessHarness } from '../support/processes';
import { assertLedger } from '../support/assert-ledger';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

test('morte SO após commit antes ACK permite redelivery sem repetir efeito financeiro', async () => {
  const f = await inboxFixture(orm), harness = new ProcessHarness();
  try {
    await harness.start(2); await f.send();
    const killed = harness.nodes[0]!, survivor = harness.nodes[1]!;
    const first = killed.command({ action: 'consumer', queueUrl: f.queueUrl, consumerName: f.consumerName, hold: true });
    expect((await first.stage('committed')).entityId).toBe('1');
    const original = await orm.em.fork().findOneOrFail(WagerRecord, { providerId: 'aurora', externalTransactionId: f.envelope.data.externalTransactionId });
    expect(original.status).toBe('PROCESSED');
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).toBe(1);
    await killed.close(); expect(killed.process.killed).toBe(true);
    let deliveries = 0, receiveCount = 0;
    const deadline = Date.now() + 10000;
    while (!deliveries && Date.now() < deadline) {
      const retry = survivor.command({ action: 'consumer', queueUrl: f.queueUrl, consumerName: f.consumerName });
      deliveries = await retry.done;
      if (deliveries) receiveCount = Number((await retry.stage('committed')).entityId);
    }
    expect(deliveries).toBe(1); expect(receiveCount).toBeGreaterThanOrEqual(2);
    expect((await orm.em.fork().findOneOrFail(WalletRecord, { id: f.wallet.id })).balance).toBe('75.00');
    expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id, kind: 'BET' })).toBe(1);
    expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id, direction: 'DEBIT' })).toBe(1);
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).toBe(1);
    const empty = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }));
    expect(empty.Messages ?? []).toHaveLength(0); await assertLedger(orm, f.wallet.id);
  } finally { try { await harness.close(); } finally { await f.close(); } }
}, 60000);

test('dois publishers SO respeitam leases ativos com owners distintos na mesma outbox', async () => {
  const f = await inboxFixture(orm), harness = new ProcessHarness();
  try {
    await f.submit.execute(f.envelope.data, { idempotencyKey: f.envelope.data.idempotencyKey, correlationId: f.envelope.messageId });
    const rows = await orm.em.fork().find(OutboxRecord, { aggregateId: f.wallet.id });
    const ids = rows.map(row => row.id); expect(ids.length).toBeGreaterThanOrEqual(2);
    await harness.start(2);
    const first = harness.nodes[0]!.command({ action: 'publisher', queueUrl: f.queueUrl, ids, hold: true });
    const held = (await first.stage('sent')).entityId!;
    const owner = (await orm.em.fork().findOneOrFail(OutboxRecord, { id: held })).leaseOwner;
    expect(owner).not.toBeNull();
    const second = harness.nodes[1]!.command({ action: 'publisher', queueUrl: f.queueUrl, ids, hold: true });
    const otherId = (await second.stage('sent')).entityId!;
    expect(otherId).not.toBe(held);
    const otherOwner = (await orm.em.fork().findOneOrFail(OutboxRecord, { id: otherId })).leaseOwner;
    expect(otherOwner).not.toBeNull(); expect(otherOwner).not.toBe(owner);
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { id: held })).publishedAt).toBeNull();
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { id: held })).leaseOwner).toBe(owner);
    second.release(); expect(await second.done).toBe(1);
    first.release(); expect(await first.done).toBe(1);
    for (let attempt = 0; attempt < ids.length; attempt++) {
      if (!await harness.nodes[1]!.command({ action: 'publisher', queueUrl: f.queueUrl, ids }).done) break;
    }
    expect(await orm.em.fork().count(OutboxRecord, { id: { $in: ids }, publishedAt: { $ne: null } })).toBe(ids.length);
    const delivered = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    expect(new Set(delivered.Messages?.map(message => (JSON.parse(message.Body!) as { eventId: string }).eventId))).toEqual(new Set(ids));
  } finally { try { await harness.close(); } finally { await f.close(); } }
}, 60000);

test('morte SO depois Send antes publishedAt recupera lease com mesmo eventId', async () => {
  const f = await inboxFixture(orm), harness = new ProcessHarness();
  try {
    const event = await orm.em.fork().findOneOrFail(OutboxRecord, { aggregateId: f.wallet.id });
    await harness.start(2);
    const first = harness.nodes[0]!.command({ action: 'publisher', queueUrl: f.queueUrl, ids: [event.id], hold: true, leaseMs: 4000 });
    expect((await first.stage('sent')).entityId).toBe(event.id);
    const accepted = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }));
    expect(accepted.Messages).toHaveLength(1);
    const originalBody = accepted.Messages![0]!.Body;
    expect((JSON.parse(originalBody!) as { eventId: string }).eventId).toBe(event.id);
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { id: event.id })).publishedAt).toBeNull();
    await harness.nodes[0]!.close();
    let reclaimed = 0; const deadline = Date.now() + 10000;
    while (!reclaimed && Date.now() < deadline) {
      const state = await orm.em.fork().execute<{ due: boolean }[]>('select lease_until <= statement_timestamp() as due from outbox_message where id = ?', [event.id]);
      if (!state[0]!.due) { await Bun.sleep(20); continue; }
      reclaimed = await harness.nodes[1]!.command({ action: 'publisher', queueUrl: f.queueUrl, ids: [event.id], leaseMs: 4000 }).done;
    }
    expect(reclaimed).toBe(1);
    const after = await orm.em.fork().findOneOrFail(OutboxRecord, { id: event.id });
    expect(after.publishedAt).not.toBeNull(); expect(after.leaseOwner).toBeNull();
    expect(after.payload).toEqual(event.payload);
    expect(JSON.stringify(after.payload)).toBe(originalBody!);
    expect(await orm.em.fork().count(OutboxRecord, { id: event.id })).toBe(1);
    // FIFO pode deduplicar a segunda entrega; o eventId estável não depende dessa janela para a auditoria SQL.
  } finally { try { await harness.close(); } finally { await f.close(); } }
}, 60000);

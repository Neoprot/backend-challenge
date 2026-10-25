import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { WalletRecord, WagerRecord, LedgerRecord, OutboxRecord, InboxRecord } from '../../src/persistence/records';
import { SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { inboxFixture } from '../support/inbox-fixture';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { Money } from '../../src/shared/domain/money';
import { testEnvironment } from '../support/environment';
import { failAfter } from '../support/faults';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import type { IdempotentUnitOfWork } from '../../src/wagering/application/idempotency';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';
import { assertLedger } from '../support/assert-ledger';

let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment();
  const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

test('unidade de trabalho preserva falha arbitrária lançada pelo callback', async () => {
  let received: unknown = 'não executado';
  try { await new PostgresUnitOfWork(orm).run(async () => { throw null; }); } catch (error) { received = error; }
  expect(received).toBeNull();
});

test.each(['insertWallet', 'insertWager', 'insertLedger', 'enqueue'] as const)('falha após %s desfaz toda a abertura já enviada ao PostgreSQL', async stage => {
  const generated: string[] = [];
  let reached = false;
  const injected = new Error('Falha controlada de atomicidade');
  const uow = failAfter(new PostgresUnitOfWork(orm), stage, injected, () => { reached = true; });
  const opener = new OpenWallet(uow, { now: () => new Date() }, { next: () => { const id = crypto.randomUUID(); generated.push(id); return id; } });
  const playerId = crypto.randomUUID();
  let error: unknown;
  try { await opener.execute({ playerId, initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }), correlationId: crypto.randomUUID() }); } catch (e) { error = e; }
  expect(reached).toBe(true); expect(error).toBe(injected);
  const em = orm.em.fork();
  expect(await em.count(WalletRecord, { playerId })).toBe(0);
  expect(await em.count(WagerRecord, { playerId })).toBe(0);
  expect(await em.count(LedgerRecord, { walletId: { $in: generated } })).toBe(0);
  expect(await em.count(OutboxRecord, { id: { $in: generated } })).toBe(0);
});

test.each([['BET', '25.00'], ['WIN', '10.00'], ['BET', '101.00']] as const)('falha antes de confirmar %s %s desfaz todos os efeitos financeiros', async (kind, amount) => {
  const ids = new UuidIdentifiers(), clock = { now: () => new Date() };
  const real = new PostgresUnitOfWork(orm);
  const wallet = await new OpenWallet(real, clock, ids).execute({ playerId: ids.next(), initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: ids.next() });
  const key = ids.next(), failure = new Error('Falha controlada antes de commit');
  let transactionId = '', reached = false, received: unknown;
  const faulty: IdempotentUnitOfWork = { runIdempotent: (tx, work, options) => real.runIdempotent(tx, async session => {
    const result = await work(session); transactionId = result.transactionId; reached = true; throw failure;
  }, options) };
  const input = { providerId: 'aurora', externalTransactionId: ids.next(), playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' } };
  try { await new SubmitWager(faulty, clock, ids).execute(input, { idempotencyKey: key, correlationId: ids.next() }); } catch (error) { received = error; }
  expect(reached).toBe(true); expect(received).toBe(failure);
  const em = orm.em.fork();
  expect(await em.findOneOrFail(WalletRecord, { id: wallet.id })).toMatchObject({ balance: '100.00', version: 1 });
  expect(await em.count(WagerRecord, { idempotencyKey: key })).toBe(0);
  expect(await em.count(LedgerRecord, { walletId: wallet.id })).toBe(1);
  expect(await em.count(OutboxRecord, { aggregateId: transactionId })).toBe(0);
  const events = await em.find(OutboxRecord, { aggregateId: wallet.id });
  expect(events).toHaveLength(1);
  expect((events[0]!.payload as { data: { transactionId: string } }).data.transactionId).not.toBe(transactionId);
  await assertLedger(orm, wallet.id);
});

test('falha após inserir inbox não deixa linha parcial; reiniciar consumidor recupera mensagem real sem ack antecipado', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.sqs.send(new SetQueueAttributesCommand({ QueueUrl: f.queueUrl, Attributes: { VisibilityTimeout: '1' } }));
    const injected = new Error('Falha após INSERT da inbox'); let reached = false, caught: unknown;
    const faulty = new PostgresUnitOfWork(orm, { afterInboxReserved: async () => { reached = true; throw injected; } });
    const submit = new SubmitWager(faulty, f.clock, f.ids);
    await f.send();
    try { await new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1 }).pollOnce(); } catch (error) { caught = error; }
    expect(reached).toBe(true); expect(caught).toBe(injected);
    const em = orm.em.fork();
    expect(await em.count(InboxRecord, { consumerName: f.consumerName })).toBe(0);
    expect(await em.count(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })).toBe(0);
    expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '100.00', version: 1 });
    expect(await em.count(LedgerRecord, { walletId: f.wallet.id })).toBe(1);
    expect(await em.count(OutboxRecord, { aggregateId: f.wallet.id })).toBe(1);
    await Bun.sleep(1100);
    expect(await new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 }).pollOnce()).toBe(1);
    const fresh = orm.em.fork(), tx = await fresh.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('PROCESSED');
    expect(await fresh.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '75.00', version: 2 });
    expect((await fresh.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    expect(await fresh.count(LedgerRecord, { transactionId: tx.id })).toBe(1);
    expect(await fresh.count(OutboxRecord, { aggregateId: tx.id })).toBe(1);
    expect(await fresh.count(OutboxRecord, { aggregateId: f.wallet.id })).toBe(2);
    await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
}, 15000);

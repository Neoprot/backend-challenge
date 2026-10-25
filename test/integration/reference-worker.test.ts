import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { WagerRecord, OutboxRecord, LedgerRecord, WalletRecord, InboxRecord } from '../../src/persistence/records';
import { LockMode } from '@mikro-orm/core';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { PostgresReferenceStore } from '../../src/persistence/reference-store';
import { ReferenceWorker } from '../../src/workers/reference-worker';
import { testEnvironment } from '../support/environment';
import { referenceFixture } from '../support/reference-fixture';
import { assertLedger } from '../support/assert-ledger';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});

test('restart preserva tentativas e agenda; TTL de 24 horas rejeita uma única vez sem novo evento de espera', async () => {
  const f = await referenceFixture(orm), command = f.command('REFUND', '25.00', f.ids.next()), context = f.context();
  const first = await f.service.execute(command, context);
  const worker = () => new ReferenceWorker(new PostgresReferenceStore(orm), new SubmitWager(new PostgresUnitOfWork(orm), { now: () => f.at }, f.ids), f.ids, { now: () => f.at }, { ids: [first.transactionId] });
  expect(await worker().pollOnce()).toBe(0);
  const start = f.at.getTime(); f.at.setTime(start + 1000);
  expect(await worker().pollOnce()).toBe(1);
  expect(await orm.em.fork().findOneOrFail(WagerRecord, first.transactionId)).toMatchObject({ attempts: 1, nextAttemptAt: new Date(start + 2000), leaseOwner: null });
  expect(await worker().pollOnce()).toBe(0);
  f.at.setTime(start + 2000); await worker().pollOnce();
  expect(await orm.em.fork().findOneOrFail(WagerRecord, first.transactionId)).toMatchObject({ attempts: 2, nextAttemptAt: new Date(start + 4000) });
  await orm.em.fork().nativeUpdate(WagerRecord, first.transactionId, { attempts: 50 });
  f.at.setTime(start + 4000); await worker().pollOnce();
  expect((await orm.em.fork().findOneOrFail(WagerRecord, first.transactionId)).nextAttemptAt).toEqual(new Date(start + 304000));
  f.at.setTime(start + 86400000 - 1); await worker().pollOnce();
  expect((await orm.em.fork().findOneOrFail(WagerRecord, first.transactionId)).nextAttemptAt).toEqual(new Date(start + 86400000));
  f.at.setTime(start + 86400000); expect(await worker().pollOnce()).toBe(1);
  expect(await worker().pollOnce()).toBe(0);
  expect(await f.service.execute(command, context)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_EXPIRED', balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: true });
  expect(await orm.em.fork().count(OutboxRecord, { aggregateId: first.transactionId, eventType: 'WagerTransactionPendingReference' })).toBe(1);
  expect(await orm.em.fork().count(OutboxRecord, { aggregateId: first.transactionId, eventType: 'WagerTransactionRejected' })).toBe(1);
  expect(await orm.em.fork().count(LedgerRecord, { transactionId: first.transactionId })).toBe(0);
  await assertLedger(orm, f.wallet.id);
});

test.each(['REJECTED', 'FAILED'] as const)('referência que termina %s rejeita a pendência imediatamente', async status => {
  const f = await referenceFixture(orm), bet = f.command('BET', '101.00');
  const pending = await f.service.execute(f.command('REFUND', '101.00', bet.externalTransactionId), f.context());
  if (status === 'FAILED') await f.service.recordPermanentFailure(bet, f.context());
  else await f.service.execute(bet, f.context());
  f.at.setTime(f.at.getTime() + 1000);
  await new ReferenceWorker(new PostgresReferenceStore(orm), f.service, f.ids, { now: () => f.at }, { ids: [pending.transactionId] }).pollOnce();
  expect(await orm.em.fork().findOneOrFail(WagerRecord, pending.transactionId)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
  expect(await orm.em.fork().count(LedgerRecord, { transactionId: pending.transactionId })).toBe(0);
  await assertLedger(orm, f.wallet.id);
});

test('dois workers reais: claim libera seleção antes da carteira; lease vencido e owner antigo não creditam', async () => {
  const f = await referenceFixture(orm), bet = f.command('BET', '25.00');
  const pending = await f.service.execute(f.command('REFUND', '25.00', bet.externalTransactionId), f.context());
  await f.service.execute(bet, f.context()); f.at.setTime(f.at.getTime() + 1000);
  let unlock!: () => void, locked!: () => void;
  const hold = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
  const barrier = orm.em.fork().transactional(async em => { await em.findOneOrFail(WalletRecord, f.wallet.id, { lockMode: LockMode.PESSIMISTIC_WRITE }); locked(); await hold; });
  await ready;
  const owner1 = f.ids.next(), owner2 = f.ids.next(), store = new PostgresReferenceStore(orm);
  const a = new ReferenceWorker(store, f.service, { next: () => owner1 }, { now: () => f.at }, { ids: [pending.transactionId], leaseMs: 1000 });
  const b = new ReferenceWorker(store, f.service, { next: () => owner2 }, { now: () => f.at }, { ids: [pending.transactionId], leaseMs: 30000 });
  const first = a.pollOnce();
  try {
    let observed = false;
    for (let i = 0; i < 100; i++) {
      if ((await orm.em.fork().findOneOrFail(WagerRecord, pending.transactionId)).leaseOwner === owner1) { observed = true; break; }
      await Bun.sleep(5);
    }
    expect(observed).toBe(true);
    expect(await b.pollOnce()).toBe(0);
    // Se o primeiro retivesse lock na pendência enquanto aguarda carteira, este novo claim bloquearia.
    f.at.setTime(f.at.getTime() + 1000);
    expect(await store.claim({ owner: owner2, limit: 1, leaseMs: 30000, now: f.at, ids: [pending.transactionId] })).toEqual([pending.transactionId]);
  } finally { unlock(); await barrier; await first; }
  expect((await orm.em.fork().findOneOrFail(WagerRecord, pending.transactionId)).status).toBe('PENDING_REFERENCE');
  await f.service.reprocessPending(pending.transactionId, owner2, () => f.at);
  await f.service.reprocessPending(pending.transactionId, owner1, () => f.at);
  expect(await orm.em.fork().count(LedgerRecord, { transactionId: pending.transactionId })).toBe(1);
  expect(await orm.em.fork().count(OutboxRecord, { aggregateId: pending.transactionId, eventType: 'WagerTransactionProcessed' })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

test('falha após movimento antes do commit reverte tudo; lease permite retomada sem nova inbox', async () => {
  const f = await referenceFixture(orm), bet = f.command('BET', '25.00');
  const inbox = { consumerName: `reference-${f.ids.next()}`, messageId: f.ids.next(), payloadHash: 'a'.repeat(64), receivedAt: new Date(f.at) };
  const pending = await f.service.execute(f.command('ROLLBACK', '25.00', bet.externalTransactionId), { ...f.context(), causationId: f.ids.next(), inbox });
  await f.service.execute(bet, f.context()); f.at.setTime(f.at.getTime() + 1000);
  const inboxBefore = await orm.em.fork().count(InboxRecord, {});
  const acceptedInbox = await orm.em.fork().findOneOrFail(InboxRecord, { consumerName: inbox.consumerName, messageId: inbox.messageId });
  expect(acceptedInbox.processedAt).not.toBeNull();
  const failure = new Error('Falha antes do commit');
  const broken = new SubmitWager(new PostgresUnitOfWork(orm, { beforePendingCommit: async () => { throw failure; } }), { now: () => f.at }, f.ids);
  const worker = (processor: SubmitWager) => new ReferenceWorker(new PostgresReferenceStore(orm), processor, f.ids, { now: () => f.at }, { ids: [pending.transactionId], leaseMs: 1000 });
  let caught: unknown; try { await worker(broken).pollOnce(); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(await orm.em.fork().count(LedgerRecord, { transactionId: pending.transactionId })).toBe(0);
  expect(await orm.em.fork().count(OutboxRecord, { aggregateId: pending.transactionId, eventType: 'WagerTransactionProcessed' })).toBe(0);
  expect(await orm.em.fork().findOneOrFail(WalletRecord, f.wallet.id)).toMatchObject({ balance: '75.00' });
  expect(await orm.em.fork().findOneOrFail(WagerRecord, pending.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0 });
  f.at.setTime(f.at.getTime() + 1000); await worker(f.service).pollOnce();
  const em = orm.em.fork();
  const original = await em.findOneOrFail(OutboxRecord, { aggregateId: pending.transactionId, eventType: 'WagerTransactionPendingReference' });
  const completed = await em.findOneOrFail(OutboxRecord, { aggregateId: pending.transactionId, eventType: 'WagerTransactionProcessed' });
  expect(completed.payload).toMatchObject({ correlationId: (original.payload as Record<string, unknown>).correlationId, causationId: (original.payload as Record<string, unknown>).causationId });
  expect(await em.count(InboxRecord, {})).toBe(inboxBefore);
  expect(await em.findOneOrFail(InboxRecord, { consumerName: inbox.consumerName, messageId: inbox.messageId })).toEqual(acceptedInbox);
  expect(await em.count(LedgerRecord, { transactionId: pending.transactionId })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});
afterAll(async () => { await orm?.close(true); });
test('claim e fence de produção usam PostgreSQL apesar de relógio da aplicação adiantado', async () => {
  const f = await referenceFixture(orm);
  const [row] = await orm.em.fork().execute<{ now: Date }[]>('select statement_timestamp() as now');
  f.at.setTime(new Date(row!.now).getTime());
  const bet = f.command('BET', '25.00');
  const pending = await f.service.execute(f.command('REFUND', '25.00', bet.externalTransactionId), f.context());
  await f.service.execute(bet, f.context());
  await orm.em.fork().nativeUpdate(WagerRecord, pending.transactionId, { nextAttemptAt: new Date(f.at.getTime() - 1) });
  f.at.setTime(f.at.getTime() + 7 * 86400000);
  const worker = new ReferenceWorker(new PostgresReferenceStore(orm), f.service, f.ids, undefined, { ids: [pending.transactionId] });
  expect(await worker.pollOnce()).toBe(1);
  expect(await orm.em.fork().findOneOrFail(WagerRecord, pending.transactionId)).toMatchObject({ status: 'PROCESSED' });
  await assertLedger(orm, f.wallet.id);
});
test.each(['REFUND', 'ROLLBACK', 'WIN'])('%s anterior à BET conclui por processamento interno e replay permanece leitura', async kind => {
  const f = await referenceFixture(orm), bet = f.command('BET', '25.00');
  const input = f.command(kind, '25.00', bet.externalTransactionId), context = f.context();
  const first = await f.service.execute(input, context);
  await f.service.execute(bet, f.context());
  expect(await f.service.execute(input, context)).toEqual({ ...first, idempotentReplay: true });
  expect(await orm.em.fork().count(LedgerRecord, { transactionId: first.transactionId })).toBe(0);
  f.at.setTime(f.at.getTime() + 1000);
  const worker = new ReferenceWorker(new PostgresReferenceStore(orm), f.service, f.ids, { now: () => f.at }, { ids: [first.transactionId] });
  expect(await worker.pollOnce()).toBe(1);
  expect(await f.service.execute(input, context)).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  expect(await orm.em.fork().count(WagerRecord, { id: first.transactionId })).toBe(1);
  expect(await orm.em.fork().count(OutboxRecord, { aggregateId: first.transactionId, eventType: 'WagerTransactionPendingReference' })).toBe(1);
  expect(await orm.em.fork().count(LedgerRecord, { transactionId: first.transactionId })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

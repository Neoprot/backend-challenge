import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { Money } from '../../src/shared/domain/money';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';
import { WalletRecord, WagerRecord, LedgerRecord, OutboxRecord } from '../../src/persistence/records';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
import { LockMode } from '@mikro-orm/core';

let orm: Awaited<ReturnType<typeof createOrm>>;
const clock = { now: () => new Date() };
const ids = new UuidIdentifiers();
beforeAll(async () => {
  const env = testEnvironment(); const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
async function fixture() {
  const uow = new PostgresUnitOfWork(orm);
  const wallet = await new OpenWallet(uow, clock, ids).execute({ playerId: ids.next(), initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: ids.next() });
  return { uow, wallet, service: new SubmitWager(uow, clock, ids),
    payload: { providerId: 'aurora', externalTransactionId: ids.next(), walletId: wallet.id, playerId: wallet.playerId,
      roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } },
    context: { idempotencyKey: ids.next(), correlationId: ids.next() } };
}
test.each([
  ['BET', '25.00', 'PROCESSED', '75.00', 2, 2, 200],
  ['WIN', '10.00', 'PROCESSED', '110.00', 2, 2, 200],
  ['LOSS', '0.00', 'PROCESSED', '100.00', 1, 1, 200],
  ['BET', '101.00', 'REJECTED', '100.00', 1, 1, 422],
] as const)('%s %s persiste estado, saldo, versão, ledger e eventos', async (kind, amount, status, balance, version, entries, httpStatus) => {
  const f = await fixture();
  const response = await f.service.execute({ ...f.payload, kind, money: { amount, currency: 'BRL' } }, f.context);
  expect(response).toMatchObject({ status, balance: { amount: balance, currency: 'BRL' }, httpStatus, terminal: true, idempotentReplay: false });
  const em = orm.em.fork();
  expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance, version });
  const tx = await em.findOneOrFail(WagerRecord, { id: response.transactionId });
  expect(tx.status).toBe(status); expect(tx.result).toMatchObject({ transactionId: tx.id, status, balance: { amount: balance, currency: 'BRL' }, httpStatus });
  expect(await em.count(LedgerRecord, { walletId: f.wallet.id })).toBe(entries);
  const events = await em.find(OutboxRecord, { aggregateId: { $in: [tx.id, f.wallet.id] } });
  const ownEvents = events.filter(event => event.aggregateId === tx.id || (event.payload as { data?: { transactionId?: string } }).data?.transactionId === tx.id);
  expect(ownEvents.map(event => event.eventType).sort()).toEqual(status === 'REJECTED' ? ['WagerTransactionRejected'] : kind === 'LOSS' ? ['WagerTransactionProcessed'] : ['WagerTransactionProcessed', 'WalletBalanceChanged']);
  if (status === 'REJECTED') expect(response.failureCode).toBe('INSUFFICIENT_FUNDS');
  await assertLedger(orm, f.wallet.id);
});
test('replay retorna saldo original após outra operação e não repete efeitos', async () => {
  const f = await fixture(); const first = await f.service.execute(f.payload, f.context);
  await f.service.execute({ ...f.payload, externalTransactionId: ids.next(), kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } }, { ...f.context, idempotencyKey: ids.next() });
  expect(await f.service.execute(f.payload, f.context)).toEqual({ ...first, idempotentReplay: true });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(3);
  await assertLedger(orm, f.wallet.id);
});

test.each(['playerId', 'currency'] as const)('vínculo divergente %s é rejeitado sem movimento', async field => {
  const f = await fixture();
  const input = field === 'playerId' ? { ...f.payload, playerId: ids.next() } : { ...f.payload, money: { amount: '25.00', currency: 'USD' } };
  const response = await f.service.execute(input, f.context);
  expect(response).toMatchObject({ status: 'REJECTED', httpStatus: 422, failureCode: field === 'playerId' ? 'WALLET_MISMATCH' : 'CURRENCY_MISMATCH' });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

test('wallet ausente retorna 404 sem reserva persistida', async () => {
  const f = await fixture(); let error: unknown;
  try { await f.service.execute({ ...f.payload, walletId: ids.next() }, f.context); } catch (e) { error = e; }
  expect(error).toMatchObject({ code: 'WALLET_NOT_FOUND', httpStatus: 404 });
  expect(await orm.em.fork().count(WagerRecord, { idempotencyKey: f.context.idempotencyKey })).toBe(0);
});

test('overflow de WIN preserva erro do domínio e desfaz reserva e efeitos', async () => {
  const uow = new PostgresUnitOfWork(orm);
  const wallet = await new OpenWallet(uow, clock, ids).execute({ playerId: ids.next(), initialBalance: Money.from({ amount: '9999999999999999999999999999.99', currency: 'BRL' }), correlationId: ids.next() });
  const key = ids.next(); let error: unknown;
  try { await new SubmitWager(uow, clock, ids).execute({ providerId: 'aurora', externalTransactionId: ids.next(), walletId: wallet.id,
    playerId: wallet.playerId, roundId: 'round', gameId: 'game', kind: 'WIN', money: { amount: '0.01', currency: 'BRL' } }, { idempotencyKey: key, correlationId: ids.next() }); } catch (e) { error = e; }
  expect(error).toMatchObject({ code: 'MONEY_OVERFLOW' });
  const em = orm.em.fork();
  expect(await em.count(WagerRecord, { idempotencyKey: key })).toBe(0);
  expect(await em.findOneOrFail(WalletRecord, { id: wallet.id })).toMatchObject({ balance: '9999999999999999999999999999.99', version: 1 });
  expect(await em.count(LedgerRecord, { walletId: wallet.id })).toBe(1);
  await assertLedger(orm, wallet.id);
});

async function holdWallet(walletId: string) {
  let release!: () => void, locked!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const done = orm.em.fork().transactional(async em => {
    await em.findOneOrFail(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    locked(); await hold;
  });
  await ready; return { release, done };
}

test('lock_timeout real esgota retries com 503 e nenhuma alteração financeira', async () => {
  const f = await fixture(); const blocker = await holdWallet(f.wallet.id);
  let error: unknown, waits = 0;
  const service = new SubmitWager(new PostgresUnitOfWork(orm, { lockTimeoutMs: 25 }), clock, ids, async () => { waits++; });
  try { await service.execute(f.payload, f.context); } catch (e) { error = e; }
  finally { blocker.release(); await blocker.done; }
  expect(error).toMatchObject({ code: 'PROCESSING_UNAVAILABLE', httpStatus: 503 }); expect(waits).toBe(2);
  const em = orm.em.fork();
  expect(await em.count(WagerRecord, { idempotencyKey: f.context.idempotencyKey })).toBe(0);
  expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '100.00', version: 1 });
  expect(await em.count(LedgerRecord, { walletId: f.wallet.id })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

test('duas BET de 80 disputam lock real e apenas uma debita saldo 100', async () => {
  const f = await fixture(); const blocker = await holdWallet(f.wallet.id);
  const first = f.service.execute({ ...f.payload, money: { amount: '80.00', currency: 'BRL' } }, f.context);
  const second = f.service.execute({ ...f.payload, externalTransactionId: ids.next(), money: { amount: '80.00', currency: 'BRL' } }, { ...f.context, idempotencyKey: ids.next() });
  let observed = false;
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await orm.em.fork().execute<{ waiting: string }[]>(`select count(*)::text as waiting from pg_stat_activity
        where usename = current_user and query ilike '%from "wallet"%for update%' and cardinality(pg_blocking_pids(pid)) > 0`);
      if (rows[0]?.waiting === '2') { observed = true; break; }
      await Bun.sleep(10);
    }
  } finally { blocker.release(); await blocker.done; }
  const results = await Promise.all([first, second]);
  expect(observed).toBe(true); expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(await orm.em.fork().findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '20.00', version: 2 });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(2);
  await assertLedger(orm, f.wallet.id);
});

import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { PostgresWalletQueries } from '../../src/persistence/wallet-queries';
import { ReadWallet } from '../../src/wallets/application/read-wallet';
import { ListLedger } from '../../src/wallets/application/list-ledger';
import { ReconcileWallet } from '../../src/wallets/application/reconcile-wallet';
import { referenceFixture } from '../support/reference-fixture';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { Money } from '../../src/shared/domain/money';
import { walletToRecord, wagerToRecord } from '../../src/persistence/mappers';
import { WalletRecord } from '../../src/persistence/records';
import type { IdempotentUnitOfWork } from '../../src/wagering/application/idempotency';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(); const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
function services() { const queries = new PostgresWalletQueries(orm); return {
  read: new ReadWallet(queries), list: new ListLedger(queries), reconcile: new ReconcileWallet(queries),
}; }
test.each(['0.00', '9007199254740993.01'])('consulta e reconciliação exatas com saldo %s', async initial => {
  const f = await referenceFixture(orm, initial); const s = services();
  expect(await s.read.execute(f.wallet.id)).toMatchObject({ id: f.wallet.id, playerId: f.wallet.playerId, balance: { amount: initial, currency: 'BRL' }, version: 1 });
  expect(await s.reconcile.execute(f.wallet.id)).toEqual({ walletId: f.wallet.id,
    storedBalance: { amount: initial, currency: 'BRL' }, calculatedBalance: { amount: initial, currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' }, consistent: true, checkedEntries: initial === '0.00' ? 0 : 1 });
  await assertLedger(orm, f.wallet.id);
});
test('reconciliação soma créditos e débitos sem alterar a carteira', async () => {
  const f = await referenceFixture(orm); const s = services();
  await f.service.execute(f.command('BET', '25.00'), f.context());
  await f.service.execute(f.command('WIN', '10.00'), f.context());
  expect(await s.reconcile.execute(f.wallet.id)).toMatchObject({ storedBalance: { amount: '85.00', currency: 'BRL' }, calculatedBalance: { amount: '85.00', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' }, checkedEntries: 3, consistent: true });
  await assertLedger(orm, f.wallet.id);
});
test('cursor desempata datas iguais e não repete itens com nova inserção', async () => {
  const f = await referenceFixture(orm); const s = services();
  for (let index = 0; index < 4; index++) await f.service.execute(f.command('WIN', '1.00'), f.context());
  const all = await s.list.execute(f.wallet.id); expect(all.items).toHaveLength(5);
  const first = await s.list.execute(f.wallet.id, { limit: 2 }); expect(first.items).toHaveLength(2); expect(first.nextCursor).toBeDefined();
  await new SubmitWager(new PostgresUnitOfWork(orm), { now: () => new Date(f.at.getTime() + 1000) }, f.ids)
    .execute(f.command('WIN', '1.00'), f.context());
  const second = await s.list.execute(f.wallet.id, { limit: 2, cursor: first.nextCursor });
  expect(second.items).toHaveLength(2); expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(4);
  const originalIds = all.items.map(item => item.id);
  expect(second.items.map(item => item.id)).toEqual(originalIds.slice(2, 4));
  const third = await s.list.execute(f.wallet.id, { limit: 2, cursor: second.nextCursor });
  expect(third.items.some(item => first.items.some(previous => previous.id === item.id))).toBe(false);
  await assertLedger(orm, f.wallet.id);
});
test('recursos ausentes respondem 404 e cursor de outra carteira responde 400', async () => {
  const s = services();
  for (const call of [() => s.read.execute(crypto.randomUUID()), () => s.list.execute(crypto.randomUUID()), () => s.reconcile.execute(crypto.randomUUID())]) {
    let received: unknown; try { await call(); } catch (error) { received = error; }
    expect(received).toMatchObject({ httpStatus: 404, code: 'WALLET_NOT_FOUND' });
  }
  const f = await referenceFixture(orm), other = await referenceFixture(orm);
  await f.service.execute(f.command('WIN', '1.00'), f.context());
  const page = await s.list.execute(f.wallet.id, { limit: 1 }); let received: unknown;
  try { await s.list.execute(other.wallet.id, { cursor: page.nextCursor }); } catch (error) { received = error; }
  expect(received).toMatchObject({ httpStatus: 400, code: 'INVALID_CURSOR' });
});
test('corrupção administrativa é reportada com diferença negativa sem correção automática', async () => {
  const f = await referenceFixture(orm); const admin = await createOrm(testEnvironment().migrationDatabaseUrl);
  try {
    await admin.em.fork().execute('update wallet set balance = ? where id = ?', ['90.00', f.wallet.id]);
    const s = services();
    expect(await s.reconcile.execute(f.wallet.id)).toMatchObject({ storedBalance: { amount: '90.00', currency: 'BRL' }, calculatedBalance: { amount: '100.00', currency: 'BRL' }, difference: { amount: '-10.00', currency: 'BRL' }, consistent: false, checkedEntries: 1 });
    expect((await s.read.execute(f.wallet.id)).balance.amount).toBe('90.00');
  } finally { await admin.em.fork().execute('update wallet set balance = ? where id = ?', ['100.00', f.wallet.id]); await admin.close(true); }
  await assertLedger(orm, f.wallet.id);
});
test('cursor preserva microssegundos reais do PostgreSQL entre páginas', async () => {
  const f = await referenceFixture(orm, '0.00');
  const timestamps = ['2026-10-25T12:00:00.123455Z', '2026-10-25T12:00:00.123456Z', '2026-10-25T12:00:00.123457Z'];
  await orm.em.fork().transactional(async em => {
    const wallet = f.wallet, stored = await em.findOneOrFail(WalletRecord, { id: wallet.id });
    for (const timestamp of timestamps) {
      const at = new Date(timestamp), tx = WagerTransaction.create({ id: f.ids.next(), providerId: 'aurora', externalTransactionId: f.ids.next(),
        idempotencyKey: f.ids.next(), payloadHash: 'a'.repeat(64), walletId: wallet.id, playerId: wallet.playerId,
        roundId: 'micro', gameId: 'micro', kind: 'WIN', money: Money.from({ amount: '1.00', currency: 'BRL' }), createdAt: at });
      tx.markProcessed(undefined, at); await em.persist(wagerToRecord(tx)).flush();
      const entry = wallet.credit(tx.money, { transactionId: tx.id, entryId: f.ids.next(), at });
      await em.execute(`insert into wallet_ledger_entry (id,wallet_id,transaction_id,direction,currency,amount,balance_before,balance_after,created_at)
        values (?,?,?,'CREDIT','BRL',?,?,?,?::timestamptz)`, [entry.id,wallet.id,tx.id,entry.money.toJSON().amount,entry.balanceBefore.toJSON().amount,entry.balanceAfter.toJSON().amount,timestamp]);
      walletToRecord(wallet, stored); await em.flush();
    }
  });
  const s = services(), first = await s.list.execute(f.wallet.id, { limit: 1 });
  const second = await s.list.execute(f.wallet.id, { limit: 1, cursor: first.nextCursor });
  const third = await s.list.execute(f.wallet.id, { limit: 1, cursor: second.nextCursor });
  expect([first.items[0]?.createdAt, second.items[0]?.createdAt, third.items[0]?.createdAt]).toEqual([...timestamps].reverse());
  expect(third.nextCursor).toBeUndefined(); await assertLedger(orm, f.wallet.id);
});
test('reconciliação usa snapshot confirmado enquanto uma transação financeira está incompleta', async () => {
  const f = await referenceFixture(orm), real = new PostgresUnitOfWork(orm);
  let release!: () => void, ready!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { ready = resolve; });
  const barrier: IdempotentUnitOfWork = { runIdempotent: (tx, work, options) => real.runIdempotent(tx, session => work({ ...session,
    saveWallet: async wallet => { await session.saveWallet(wallet); ready(); await hold; },
  }), options) };
  const operation = new SubmitWager(barrier, { now: () => f.at }, f.ids).execute(f.command('WIN', '1.00'), f.context());
  await entered;
  try { expect(await services().reconcile.execute(f.wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '100.00', currency: 'BRL' }, checkedEntries: 1 }); }
  finally { release(); await operation; }
  expect(await services().reconcile.execute(f.wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '101.00', currency: 'BRL' }, checkedEntries: 2 });
  await assertLedger(orm, f.wallet.id);
});

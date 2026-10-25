import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { WalletRecord, WagerRecord, LedgerRecord, OutboxRecord } from '../../src/persistence/records';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { Money } from '../../src/shared/domain/money';
import { testEnvironment } from '../support/environment';
import { failAfter } from '../support/faults';

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

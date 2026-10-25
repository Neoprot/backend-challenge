import { beforeAll, afterAll, expect, test } from 'bun:test';
import { LockMode } from '@mikro-orm/core';
import { createOrm } from '../../src/persistence/orm';
import { WalletRecord, WagerRecord, LedgerRecord, OutboxRecord } from '../../src/persistence/records';
import { testEnvironment } from '../support/environment';
import { referenceFixture } from '../support/reference-fixture';
import { assertLedger } from '../support/assert-ledger';

let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(); const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

// Dois contextos reais aqui; validação com processos distintos pertence ao harness da tarefa 18.
test('REFUND e ROLLBACK concorrentes confirmam somente um crédito sobre a mesma BET', async () => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '25.00');
  const original = await f.service.execute(bet, f.context());
  let release!: () => void, ready!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const blocker = orm.em.fork().transactional(async em => {
    await em.findOneOrFail(WalletRecord, { id: f.wallet.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    ready(); await hold;
  });
  await locked;
  const refund = f.service.execute(f.command('REFUND', '25.00', bet.externalTransactionId), f.context());
  const rollback = f.service.execute(f.command('ROLLBACK', '25.00', bet.externalTransactionId), f.context());
  let observed = false;
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const waiting = await orm.em.fork().execute<{ waiting: string }[]>(`select count(*)::text as waiting
        from pg_stat_activity where usename = current_user
        and query ilike '%from "wallet"%for update%' and cardinality(pg_blocking_pids(pid)) > 0`);
      if (waiting[0]?.waiting === '2') { observed = true; break; }
      await Bun.sleep(10);
    }
  } finally { release(); await blocker; }
  const results = await Promise.all([refund, rollback]);
  expect(observed).toBe(true);
  expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(results.find(result => result.status === 'REJECTED')?.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  const em = orm.em.fork();
  expect(await em.count(WagerRecord, { referenceTransactionId: original.transactionId, status: 'PROCESSED' })).toBe(1);
  expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '100.00', version: 3 });
  expect(await em.count(LedgerRecord, { walletId: f.wallet.id })).toBe(3);
  const reversalIds = results.map(result => result.transactionId);
  expect(await em.count(LedgerRecord, { transactionId: { $in: reversalIds }, direction: 'CREDIT' })).toBe(1);
  expect(await em.count(OutboxRecord, { aggregateId: { $in: reversalIds }, eventType: 'WagerTransactionProcessed' })).toBe(1);
  expect(await em.count(OutboxRecord, { aggregateId: { $in: reversalIds }, eventType: 'WagerTransactionRejected' })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

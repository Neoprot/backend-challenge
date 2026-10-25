import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { WalletRecord, WagerRecord, LedgerRecord } from '../../src/persistence/records';
import { testEnvironment } from '../support/environment';
import { accessToken } from '../support/identity';
import { financialFixture } from '../support/fixtures';
import { ProcessHarness, within } from '../support/processes';
import { Barrier } from '../support/barrier';
import { assertLedger } from '../support/assert-ledger';
const harness = new ProcessHarness();
let orm: Awaited<ReturnType<typeof createOrm>>, admin: string, provider: string;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl); admin = await accessToken('admin'); provider = await accessToken();
  await harness.start();
});
afterAll(async () => { try { await harness.close(); } finally { await orm?.close(true); } });
async function waitingFor(blockerPid: number, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await orm.em.fork().execute<{ count: string }[]>(`with recursive blocked(pid) as (
      select pid from pg_stat_activity where ? = any(pg_blocking_pids(pid))
      union select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid)))
      select count(*)::text as count from blocked`, [blockerPid]);
    if (Number(rows[0]!.count) >= count) return;
    await Bun.sleep(10);
  }
  throw new Error('As sessões esperadas não chegaram ao lock da fixture.');
}
async function holdWallet(id: string) {
  let acquired!: (pid: number) => void, release!: () => void;
  const ready = new Promise<number>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = orm.em.fork().transactional(async em => {
    await em.execute('select id from wallet where id = ? for update', [id]);
    acquired((await em.execute<{ pid: number }[]>('select pg_backend_pid() as pid'))[0]!.pid); await gate;
  });
  void done.catch(() => {});
  const pid = await Promise.race([ready, done.then(() => { throw new Error('Blocker encerrou sem confirmar o lock.'); })]);
  return { pid, release, done };
}
test('falha SQL antes do sinal do blocker não deixa a barreira pendente', async () => {
  let failure: unknown;
  try { await within(holdWallet('uuid-inválido'), 1000, 'Barreira pendente após falha do blocker.'); }
  catch (error) { failure = error; }
  expect((failure as { code?: string } | undefined)?.code).toBe('22P02');
});
test('50 BET iguais em três PIDs têm um débito e 49 replays, inclusive após restart', async () => {
  const f = await financialFixture(harness.nodes[0]!, admin, provider), command = f.command(), key = crypto.randomUUID();
  const previousPids = harness.nodes.map(node => node.pid);
  async function batch() {
    const barrier = new Barrier(50);
    const operations = Array.from({ length: 50 }, (_, index) => barrier.arriveAndWait().then(() => f.submit(harness.nodes[index % 3]!, command, key)));
    await barrier.ready; barrier.release(); return Promise.all(operations);
  }
  const first = await batch();
  expect(first.filter(result => !result.idempotentReplay)).toHaveLength(1);
  expect(first.filter(result => result.idempotentReplay)).toHaveLength(49);
  expect(new Set(first.map(result => result.transactionId)).size).toBe(1);
  const saved = [...harness.nodes]; await harness.close();
  for (const node of saved) expect(node.process.killed).toBe(true);
  await harness.start(); expect(harness.nodes.every(node => !previousPids.includes(node.pid))).toBe(true);
  const replay = await batch(); expect(replay.every(result => result.idempotentReplay)).toBe(true);
  expect(new Set(replay.map(result => result.transactionId))).toEqual(new Set(first.map(result => result.transactionId)));
  expect(await orm.em.fork().count(WagerRecord, { walletId: f.walletId, kind: 'BET' })).toBe(1);
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.walletId, direction: 'DEBIT' })).toBe(1);
  expect((await orm.em.fork().findOneOrFail(WalletRecord, { id: f.walletId })).balance).toBe('75.00');
  await assertLedger(orm, f.walletId);
}, 60000);
test('duas BET de 80 sobre 100 em processos distintos nunca gastam o mesmo saldo', async () => {
  const f = await financialFixture(harness.nodes[0]!, admin, provider), barrier = new Barrier(2);
  const operations = [0, 1].map(index => barrier.arriveAndWait().then(() => f.submit(harness.nodes[index]!, f.command({ money: { amount: '80.00', currency: 'BRL' } }))));
  await barrier.ready; barrier.release(); const results = await Promise.all(operations);
  expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(results.find(result => result.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect((await orm.em.fork().findOneOrFail(WalletRecord, { id: f.walletId })).balance).toBe('20.00');
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.walletId, direction: 'DEBIT' })).toBe(1);
  await assertLedger(orm, f.walletId);
});
test('wallet B confirma antes de liberar o lock da wallet A em outro processo', async () => {
  const a = await financialFixture(harness.nodes[0]!, admin, provider), b = await financialFixture(harness.nodes[1]!, admin, provider);
  const blocker = await holdWallet(a.walletId); let finishedA = false;
  const operationA = a.submit(harness.nodes[0]!, a.command()).finally(() => { finishedA = true; });
  try {
    await waitingFor(blocker.pid, 1);
    expect((await within(b.submit(harness.nodes[1]!, b.command()), 2000, 'Wallet B ficou presa ao lock de A.')).status).toBe('PROCESSED');
    expect(finishedA).toBe(false);
  } finally { blocker.release(); await blocker.done; await Promise.allSettled([operationA]); }
  expect((await operationA).status).toBe('PROCESSED'); await assertLedger(orm, a.walletId); await assertLedger(orm, b.walletId);
});
test('REFUND e ROLLBACK disputam a mesma referência entre dois processos e só um credita', async () => {
  const f = await financialFixture(harness.nodes[0]!, admin, provider), bet = f.command();
  const original = await f.submit(harness.nodes[0]!, bet), blocker = await holdWallet(f.walletId);
  const operations = (['REFUND', 'ROLLBACK'] as const).map((kind, index) => f.submit(harness.nodes[index]!, f.command({ kind, referenceExternalTransactionId: bet.externalTransactionId })));
  try { await waitingFor(blocker.pid, 2); } finally { blocker.release(); await blocker.done; await Promise.allSettled(operations); }
  const results = await Promise.all(operations);
  expect(results.map(result => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
  expect(results.find(result => result.status === 'REJECTED')?.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  expect(await orm.em.fork().count(WagerRecord, { referenceTransactionId: original.transactionId, status: 'PROCESSED' })).toBe(1);
  expect((await orm.em.fork().findOneOrFail(WalletRecord, { id: f.walletId })).balance).toBe('100.00');
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.walletId })).toBe(3); await assertLedger(orm, f.walletId);
});

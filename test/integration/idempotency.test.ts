import { beforeAll, afterAll, test, expect } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { WagerRecord, OutboxRecord } from '../../src/persistence/records';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { Money } from '../../src/shared/domain/money';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionProcessed } from '../../src/messaging/domain/events';
import { canonicalPayload } from '../../src/wagering/application/canonical-payload';
import type { ProcessingResult } from '../../src/wagering/application/processing-result';
import { DomainError } from '../../src/shared/domain/domain-error';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
 const env = testEnvironment(); const migration = await createOrm(env.migrationDatabaseUrl);
 try { await migration.migrator.up(); } finally { await migration.close(true); }
 orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
async function fixture() {
 const uow = new PostgresUnitOfWork(orm);
 const wallet = await new OpenWallet(uow, { now: () => new Date() }, new UuidIdentifiers()).execute({ playerId: crypto.randomUUID(), initialBalance: Money.zero('BRL'), correlationId: crypto.randomUUID() });
 const input = { providerId: 'aurora', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId, walletId: wallet.id, roundId: 'round', gameId: 'game', kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
 const key = crypto.randomUUID();
 const tx = (overrides: Record<string, unknown> = {}, idem = key) => {
  const { payload, hash } = canonicalPayload({ ...input, ...overrides });
  return WagerTransaction.create({ ...payload, id: crypto.randomUUID(), idempotencyKey: idem, payloadHash: hash, money: Money.from(payload.money), createdAt: new Date() });
 };
 return { uow, wallet, tx };
}
function result(tx: WagerTransaction): ProcessingResult { return { transactionId: tx.id, status: tx.status, httpStatus: 200, terminal: true, balance: { amount: '0.00', currency: 'BRL' } }; }
test.each(['REJECTED', 'PENDING_REFERENCE'] as const)('replay preserva resultado %s sem regravar metadado de transporte', async status => {
 const f = await fixture(); const tx = f.tx();
 const original = await f.uow.runIdempotent(tx, async () => {
  if (status === 'REJECTED') tx.reject('REFERENCE_NOT_PROCESSED'); else tx.markPendingReference();
  return { transactionId: tx.id, status, httpStatus: status === 'REJECTED' ? 422 : 202,
   terminal: status === 'REJECTED', ...(status === 'REJECTED' ? { failureCode: 'REFERENCE_NOT_PROCESSED' as const } : {}) };
 });
 const replay = await f.uow.runIdempotent(f.tx(), async () => { throw new Error('Não executar'); });
 expect(replay).toEqual({ ...original, idempotentReplay: true });
 expect(replay.balance).toBeUndefined();
 const stored = await orm.em.fork().findOneOrFail(WagerRecord, { id: tx.id });
 expect(stored.result).not.toHaveProperty('idempotentReplay');
 expect(stored.status).toBe(status);
 await assertLedger(orm, f.wallet.id);
});
test('duas inserções concorrentes convergem em resultado e um evento, inclusive após novo contexto', async () => {
 const f = await fixture(); let calls = 0;
 let release!: () => void, entered!: () => void;
 const hold = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
 const first = f.tx(), second = f.tx();
 const a = f.uow.runIdempotent(first, async session => {
  calls++; entered(); await hold;
  first.markProcessed(undefined, new Date());
  await session.enqueue(WagerTransactionProcessed.from(first, { eventId: crypto.randomUUID(), correlationId: 'test', occurredAt: new Date() }));
  return result(first);
 });
 await started;
 const b = f.uow.runIdempotent(second, async () => { calls++; second.markProcessed(undefined, new Date()); return result(second); });
 let observed = false;
 try {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
   const waiting = await orm.em.fork().execute<{ blocked: boolean }[]>(`select exists (
    select 1 from pg_stat_activity where usename = current_user and pid <> pg_backend_pid()
    and query ilike '%insert into "wager_transaction"%' and cardinality(pg_blocking_pids(pid)) > 0
   ) as blocked`);
   if (waiting[0]?.blocked) { observed = true; break; }
   await Bun.sleep(10);
  }
 } finally { release(); }
 const responses = await Promise.all([a, b]);
 expect(observed).toBe(true);
 expect(calls).toBe(1); expect(responses.map(r => r.idempotentReplay).sort()).toEqual([false, true]);
 expect(responses[0]!.transactionId).toBe(responses[1]!.transactionId);
 expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id })).toBe(1);
 expect(await orm.em.fork().count(OutboxRecord, { aggregateId: first.id })).toBe(1);
 const replay = await new PostgresUnitOfWork(orm).runIdempotent(f.tx(), async () => { throw new Error('Replay não executa efeitos'); });
 expect(replay).toEqual({ ...responses[0]!, idempotentReplay: true });
 await assertLedger(orm, f.wallet.id);
});
test('mesma chave e hash forjado não permitem reaproveitar outra identidade', async () => {
 const f = await fixture(); const first = f.tx();
 await f.uow.runIdempotent(first, async () => { first.markProcessed(undefined, new Date()); return result(first); });
 const forged = WagerTransaction.create({ id: crypto.randomUUID(), providerId: first.providerId,
  externalTransactionId: crypto.randomUUID(), idempotencyKey: first.idempotencyKey, payloadHash: first.payloadHash,
  walletId: first.walletId, playerId: first.playerId, roundId: first.roundId, gameId: first.gameId,
  kind: 'LOSS', money: Money.zero('BRL'), createdAt: new Date() });
 let received: unknown;
 try { await f.uow.runIdempotent(forged, async () => { throw new Error('Não executar'); }); } catch (error) { received = error; }
 expect((received as DomainError).code).toBe('IDEMPOTENCY_IDENTITY_CONFLICT');
 expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id })).toBe(1);
 await assertLedger(orm, f.wallet.id);
});
test('violação de constraint não relacionada não vira replay e desfaz reserva', async () => {
 const f = await fixture(); const tx = f.tx(); let received: unknown;
 try { await f.uow.runIdempotent(tx, async session => {
  await session.insertWallet(f.wallet); return result(tx);
 }); } catch (error) { received = error; }
 expect((received as { code: string }).code).toBe('23505');
 expect((received as { constraint: string }).constraint).toBe('wallet_pkey');
 expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id })).toBe(0);
 await assertLedger(orm, f.wallet.id);
});
test.each(['key', 'payload', 'identity'] as const)('conflito %s não cria outra operação', async conflict => {
 const f = await fixture(); const first = f.tx();
 await f.uow.runIdempotent(first, async () => { first.markProcessed(undefined, new Date()); return result(first); });
 const next = conflict === 'key' ? f.tx({}, crypto.randomUUID()) : conflict === 'payload' ? f.tx({ roundId: 'other' }) : f.tx({ externalTransactionId: crypto.randomUUID() });
 let failure: unknown;
 try { await f.uow.runIdempotent(next, async () => { throw new Error('Não pode executar'); }); } catch (error) { failure = error; }
 expect(failure).toBeInstanceOf(DomainError);
 expect((failure as DomainError).code).toBe(conflict === 'payload' ? 'IDEMPOTENCY_PAYLOAD_CONFLICT' : 'IDEMPOTENCY_IDENTITY_CONFLICT');
 expect((failure as { httpStatus: number }).httpStatus).toBe(409);
 expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id })).toBe(1);
 await assertLedger(orm, f.wallet.id);
});
test('falha do callback desfaz reserva e evento; nova tentativa pode concluir', async () => {
 const f = await fixture(); const first = f.tx(); const failure = new Error('Falha após evento'); let received: unknown;
 try { await f.uow.runIdempotent(first, async session => {
  first.markProcessed(undefined, new Date());
  await session.enqueue(WagerTransactionProcessed.from(first, { eventId: crypto.randomUUID(), correlationId: 'test', occurredAt: new Date() }));
  throw failure;
 }); } catch (error) { received = error; }
 expect(received).toBe(failure);
 expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id })).toBe(0);
 expect(await orm.em.fork().count(OutboxRecord, { aggregateId: first.id })).toBe(0);
 const retry = f.tx(); const response = await f.uow.runIdempotent(retry, async () => { retry.markProcessed(undefined, new Date()); return result(retry); });
 expect(response.idempotentReplay).toBe(false);
 await assertLedger(orm, f.wallet.id);
});


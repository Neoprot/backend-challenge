import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { WalletRecord, WagerRecord, LedgerRecord, OutboxRecord } from '../../src/persistence/records';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { Money } from '../../src/shared/domain/money';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';
import { DomainError } from '../../src/shared/domain/domain-error';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';

let orm: Awaited<ReturnType<typeof createOrm>>;
const at = new Date('2026-10-25T12:00:00.000Z');
beforeAll(async () => {
  const env = testEnvironment();
  const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const service = () => new OpenWallet(new PostgresUnitOfWork(orm), { now: () => at }, new UuidIdentifiers());

test('abertura positiva confirma wallet, OPENING, crédito e eventos com precisão e versão 1', async () => {
  const correlationId = crypto.randomUUID();
  const wallet = await service().execute({ playerId: crypto.randomUUID(), initialBalance: money('9007199254740993.01'), correlationId });
  const em = orm.em.fork();
  const stored = await em.findOneOrFail(WalletRecord, { id: wallet.id });
  expect(stored.balance).toBe('9007199254740993.01'); expect(stored.version).toBe(1);
  expect(stored.createdAt).toEqual(at);
  const transactions = await em.find(WagerRecord, { walletId: wallet.id });
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', amount: stored.balance, processedAt: at });
  const ledger = await em.find(LedgerRecord, { walletId: wallet.id });
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ direction: 'CREDIT', transactionId: transactions[0]!.id, balanceBefore: '0.00', balanceAfter: stored.balance });
  const events = await em.find(OutboxRecord, { aggregateId: { $in: [wallet.id, transactions[0]!.id] } });
  expect(events.map(e => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  for (const event of events) expect(event.payload).toMatchObject({ correlationId, occurredAt: at.toISOString(), eventId: event.id });
  await assertLedger(orm, wallet.id);
});

test('abertura zero mantém versão 1 sem lançamento, OPENING ou evento de saldo', async () => {
  const wallet = await service().execute({ playerId: crypto.randomUUID(), initialBalance: money('0.00'), correlationId: crypto.randomUUID() });
  const em = orm.em.fork();
  expect(await em.findOneOrFail(WalletRecord, { id: wallet.id })).toMatchObject({ balance: '0.00', version: 1 });
  expect(await em.count(WagerRecord, { walletId: wallet.id })).toBe(0);
  expect(await em.count(LedgerRecord, { walletId: wallet.id })).toBe(0);
  expect(await em.count(OutboxRecord, { aggregateId: wallet.id })).toBe(0);
  await assertLedger(orm, wallet.id);
});

test('abertura duplicada é conflito e não modifica a primeira wallet', async () => {
  const command = { playerId: crypto.randomUUID(), initialBalance: money('25.00'), correlationId: crypto.randomUUID() };
  const wallet = await service().execute(command);
  let error: unknown;
  try { await service().execute(command); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe('WALLET_ALREADY_EXISTS');
  const em = orm.em.fork();
  expect(await em.count(WalletRecord, { playerId: command.playerId })).toBe(1);
  expect(await em.count(WagerRecord, { walletId: wallet.id })).toBe(1);
  expect(await em.count(LedgerRecord, { walletId: wallet.id })).toBe(1);
  await assertLedger(orm, wallet.id);
});

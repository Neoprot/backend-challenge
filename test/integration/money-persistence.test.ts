import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { WalletRecord, WagerRecord, LedgerRecord, InboxRecord, OutboxRecord } from '../../src/persistence/records';
import { walletToRecord, walletFromRecord, wagerToRecord, wagerFromRecord, ledgerToRecord, ledgerFromRecord } from '../../src/persistence/mappers';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallets/domain/wallet';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { testEnvironment } from '../support/environment';

let orm: Awaited<ReturnType<typeof createOrm>>;
const at = new Date('2026-10-24T12:00:00.000Z');
beforeAll(async () => {
  const env = testEnvironment();
  const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

test.each(['9007199254740993.01', '9999999999999999999999999999.99'])('wallet preserva %s no round-trip NUMERIC', async amount => {
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: Money.from({ amount, currency: 'USD' }), at });
  const em = orm.em.fork();
  em.persist(walletToRecord(wallet)); await em.flush();
  em.clear();
  const record = await em.findOneOrFail(WalletRecord, { id: wallet.id });
  expect(typeof record.balance).toBe('string');
  expect(record.balance).toBe(amount);
  const restored = walletFromRecord(record);
  expect(restored.balance.toJSON()).toEqual({ amount, currency: 'USD' });
  expect(restored.version).toBe(1);
  expect(restored.createdAt.toISOString()).toBe(at.toISOString());
});

test('transação e ledger preservam domínio e metadados técnicos', async () => {
  const em = orm.em.fork();
  const wallet = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: Money.from({ amount: '9007199254740993.01', currency: 'BRL' }), at });
  const tx = WagerTransaction.create({ id: crypto.randomUUID(), providerId: 'aurora', externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), payloadHash: 'a'.repeat(64), walletId: wallet.id, playerId: wallet.playerId, roundId: 'round', gameId: 'game', kind: 'BET', money: Money.from({ amount: '0.01', currency: 'BRL' }), createdAt: at });
  const walletRecord = walletToRecord(wallet);
  em.persist(walletRecord); await em.flush();
  const pending = wagerToRecord(tx);
  pending.attempts = 3;
  pending.nextAttemptAt = at;
  pending.referenceDeadline = at;
  pending.leaseOwner = crypto.randomUUID();
  pending.leaseUntil = at;
  pending.result = { balance: { amount: '9007199254740993.00', currency: 'BRL' } };
  em.persist(pending); await em.flush();
  const entry = wallet.debit(tx.money, { transactionId: tx.id, entryId: crypto.randomUUID(), at });
  tx.markProcessed(undefined, at);
  const updated = wagerToRecord(tx, pending);
  expect(updated).toBe(pending);
  expect(updated.attempts).toBe(3);
  expect(walletToRecord(wallet, walletRecord)).toBe(walletRecord);
  em.persist([updated, walletRecord, ledgerToRecord(entry)]); await em.flush();
  em.clear();
  const persisted = await em.findOneOrFail(WagerRecord, { id: tx.id });
  const restored = wagerFromRecord(persisted);
  const savedWallet = await em.findOneOrFail(WalletRecord, { id: wallet.id });
  expect(savedWallet.balance).toBe('9007199254740993.00');
  expect(savedWallet.version).toBe(2);
  expect(restored.status).toBe('PROCESSED');
  expect(restored.money.toJSON().amount).toBe('0.01');
  expect(restored.processedAt?.toISOString()).toBe(at.toISOString());
  expect(persisted.attempts).toBe(3);
  expect(persisted.result).toEqual(pending.result);
  expect(persisted.leaseOwner).toBe(pending.leaseOwner);
  expect(persisted.leaseUntil?.toISOString()).toBe(at.toISOString());
  expect(persisted.nextAttemptAt?.toISOString()).toBe(at.toISOString());
  expect(persisted.referenceDeadline?.toISOString()).toBe(at.toISOString());
  const ledger = ledgerFromRecord(await em.findOneOrFail(LedgerRecord, { id: entry.id }));
  expect(ledger.balanceBefore.toJSON().amount).toBe('9007199254740993.01');
  expect(ledger.balanceAfter.toJSON().amount).toBe('9007199254740993.00');
  expect(ledger.isBalanced()).toBe(true);
});

test('campos opcionais e falha de domínio atravessam o mapper sem undefined persistido', () => {
  const tx = WagerTransaction.create({ id: crypto.randomUUID(), providerId: 'aurora', externalTransactionId: 'refunding', idempotencyKey: crypto.randomUUID(), payloadHash: 'b'.repeat(64), walletId: crypto.randomUUID(), playerId: crypto.randomUUID(), roundId: 'r', gameId: 'g', kind: 'REFUND', money: Money.from({ amount: '1.00', currency: 'BRL' }), referenceExternalTransactionId: 'original', createdAt: at });
  tx.reject('REFERENCE_EXPIRED');
  const record = wagerToRecord(tx);
  expect(record.referenceTransactionId).toBeNull();
  expect(record.processedAt).toBeNull();
  const restored = wagerFromRecord(record);
  expect(restored.failureCode).toBe('REFERENCE_EXPIRED');
  expect(restored.referenceExternalTransactionId).toBe('original');
  expect(restored.referenceTransactionId).toBeUndefined();
});

test('inbox composta e outbox mapeiam JSON, leases e datas', async () => {
  const em = orm.em.fork();
  const inbox = em.create(InboxRecord, { consumerName: 'mapping-test', messageId: crypto.randomUUID(), payloadHash: 'c'.repeat(64), receivedAt: at, processedAt: at });
  const outbox = em.create(OutboxRecord, { id: crypto.randomUUID(), aggregateId: crypto.randomUUID(), eventType: 'WalletBalanceChanged', payload: { money: { amount: '0.01', currency: 'BRL' } }, occurredAt: at, attempts: 2, nextAttemptAt: at, leaseOwner: crypto.randomUUID(), leaseUntil: at });
  em.persist([inbox, outbox]); await em.flush();
  em.clear();
  const received = await em.findOneOrFail(InboxRecord, { consumerName: inbox.consumerName, messageId: inbox.messageId });
  const sent = await em.findOneOrFail(OutboxRecord, { id: outbox.id });
  expect(received.processedAt?.toISOString()).toBe(at.toISOString());
  expect(sent.payload).toEqual(outbox.payload);
  expect(sent.attempts).toBe(2);
  expect(sent.leaseOwner).toBe(outbox.leaseOwner);
  expect(sent.publishedAt).toBeNull();
});

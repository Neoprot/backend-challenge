import { DecimalType, EntitySchema } from '@mikro-orm/core';
import { InboxRecord, LedgerRecord, OutboxRecord, WagerRecord, WalletRecord } from './records';

const uuid = () => ({ type: 'uuid' });
const text = (length: number) => ({ type: 'string', length });
const timestamp = () => ({ type: Date, columnType: 'timestamptz' });
const money = () => ({ type: new DecimalType('string'), precision: 30, scale: 2 });

export const walletSchema = new EntitySchema({
  class: WalletRecord, tableName: 'wallet',
  properties: {
    id: { ...uuid(), primary: true }, playerId: uuid(), currency: text(3),
    balance: money(), version: { type: 'integer' }, createdAt: timestamp(), updatedAt: timestamp(),
  },
});

export const wagerSchema = new EntitySchema({
  class: WagerRecord, tableName: 'wager_transaction',
  properties: {
    id: { ...uuid(), primary: true }, providerId: text(120), externalTransactionId: text(200),
    idempotencyKey: text(320), payloadHash: text(64), walletId: uuid(), playerId: uuid(),
    roundId: text(200), gameId: text(200), kind: text(16), currency: text(3), amount: money(),
    status: text(24), referenceExternalTransactionId: { ...text(200), nullable: true },
    referenceTransactionId: { ...uuid(), nullable: true }, failureCode: { ...text(80), nullable: true },
    createdAt: timestamp(), processedAt: { ...timestamp(), nullable: true }, result: { type: 'json', nullable: true },
    attempts: { type: 'integer', default: 0 }, nextAttemptAt: { ...timestamp(), nullable: true },
    referenceDeadline: { ...timestamp(), nullable: true }, leaseOwner: { ...uuid(), nullable: true },
    leaseUntil: { ...timestamp(), nullable: true },
  },
});

export const ledgerSchema = new EntitySchema({
  class: LedgerRecord, tableName: 'wallet_ledger_entry',
  properties: {
    id: { ...uuid(), primary: true }, walletId: uuid(), transactionId: uuid(), direction: text(6),
    currency: text(3), amount: money(), balanceBefore: money(), balanceAfter: money(), createdAt: timestamp(),
  },
});

export const inboxSchema = new EntitySchema({
  class: InboxRecord, tableName: 'inbox_message',
  properties: {
    consumerName: { ...text(120), primary: true }, messageId: { ...text(200), primary: true },
    payloadHash: text(64), receivedAt: timestamp(), processedAt: { ...timestamp(), nullable: true },
  },
});

export const outboxSchema = new EntitySchema({
  class: OutboxRecord, tableName: 'outbox_message',
  properties: {
    id: { ...uuid(), primary: true }, aggregateId: uuid(), eventType: text(120), payload: { type: 'json' },
    occurredAt: timestamp(), attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { ...timestamp(), nullable: true }, publishedAt: { ...timestamp(), nullable: true },
    leaseOwner: { ...uuid(), nullable: true }, leaseUntil: { ...timestamp(), nullable: true },
  },
});

export const persistenceSchemas = [walletSchema, wagerSchema, ledgerSchema, inboxSchema, outboxSchema];

import { Money } from '../shared/domain/money';
import { Wallet } from '../wallets/domain/wallet';
import { WalletLedgerEntry } from '../wallets/domain/ledger-entry';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { LedgerRecord, WagerRecord, WalletRecord } from './records';

export function walletToRecord(wallet: Wallet, existing?: WalletRecord): WalletRecord {
  return Object.assign(existing ?? new WalletRecord(), {
    id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
    balance: wallet.balance.toJSON().amount, version: wallet.version,
    createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
  });
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id, playerId: record.playerId, currency: record.currency,
    balance: Money.rehydrate({ amount: record.balance, currency: record.currency }),
    version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}

export function wagerToRecord(transaction: WagerTransaction, existing?: WagerRecord): WagerRecord {
  return Object.assign(existing ?? new WagerRecord(), {
    id: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey, payloadHash: transaction.payloadHash,
    walletId: transaction.walletId, playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId,
    kind: transaction.kind, currency: transaction.money.currency, amount: transaction.money.toJSON().amount,
    status: transaction.status, referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null, failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt, processedAt: transaction.processedAt ?? null,
  });
}

export function wagerFromRecord(record: WagerRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id, providerId: record.providerId, externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey, payloadHash: record.payloadHash,
    walletId: record.walletId, playerId: record.playerId, roundId: record.roundId, gameId: record.gameId,
    kind: record.kind, money: Money.rehydrate({ amount: record.amount, currency: record.currency }),
    status: record.status, createdAt: record.createdAt,
    ...(record.referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId: record.referenceExternalTransactionId }),
    ...(record.referenceTransactionId === null ? {} : { referenceTransactionId: record.referenceTransactionId }),
    ...(record.failureCode === null ? {} : { failureCode: record.failureCode }),
    ...(record.processedAt === null ? {} : { processedAt: record.processedAt }),
  });
}

export function ledgerToRecord(entry: WalletLedgerEntry): LedgerRecord {
  return Object.assign(new LedgerRecord(), {
    id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
    currency: entry.money.currency, amount: entry.money.toJSON().amount,
    balanceBefore: entry.balanceBefore.toJSON().amount, balanceAfter: entry.balanceAfter.toJSON().amount, createdAt: entry.createdAt,
  });
}

export function ledgerFromRecord(record: LedgerRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id, walletId: record.walletId, transactionId: record.transactionId, direction: record.direction,
    money: Money.rehydrate({ amount: record.amount, currency: record.currency }),
    balanceBefore: Money.rehydrate({ amount: record.balanceBefore, currency: record.currency }),
    balanceAfter: Money.rehydrate({ amount: record.balanceAfter, currency: record.currency }), createdAt: record.createdAt,
  });
}

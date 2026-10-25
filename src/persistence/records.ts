import type { Opt } from '@mikro-orm/core';
import type { LedgerDirection } from '../wallets/domain/ledger-entry';
import type { FailureCode } from '../wagering/domain/failure-code';
import type { WagerTransactionKind, WagerTransactionStatus } from '../wagering/domain/wager-transaction';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  currency!: string;
  amount!: string;
  status!: WagerTransactionStatus;
  referenceExternalTransactionId: Opt<string> | null = null;
  referenceTransactionId: Opt<string> | null = null;
  failureCode: Opt<FailureCode> | null = null;
  createdAt!: Date;
  processedAt: Opt<Date> | null = null;
  result: Opt<JsonValue> | null = null;
  attempts: Opt<number> = 0;
  nextAttemptAt: Opt<Date> | null = null;
  referenceDeadline: Opt<Date> | null = null;
  leaseOwner: Opt<string> | null = null;
  leaseUntil: Opt<Date> | null = null;
}

export class LedgerRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  currency!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt: Opt<Date> | null = null;
}

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: JsonValue;
  occurredAt!: Date;
  attempts: Opt<number> = 0;
  nextAttemptAt: Opt<Date> | null = null;
  publishedAt: Opt<Date> | null = null;
  leaseOwner: Opt<string> | null = null;
  leaseUntil: Opt<Date> | null = null;
}

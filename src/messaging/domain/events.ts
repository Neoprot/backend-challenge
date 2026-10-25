import { DomainError } from '../../shared/domain/domain-error';
import type { MoneyProps } from '../../shared/domain/money';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry, LedgerDirection } from '../../wallets/domain/ledger-entry';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction';
import type { FailureCode } from '../../wagering/domain/failure-code';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from './integration-event';

export interface WagerEventData {
  transactionId: string; providerId: string; externalTransactionId: string; walletId: string; playerId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; status: WagerTransactionStatus; money: MoneyProps;
  failureCode?: FailureCode;
}
function wagerProps(tx: WagerTransaction, ctx: EventContext, status: WagerTransactionStatus): IntegrationEventProps<WagerEventData> {
  if (tx.status !== status) throw new DomainError('INVALID_EVENT_STATE', 'Estado incompatível com o evento.');
  return { ...ctx, aggregateId: tx.id, data: {
    transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
    kind: tx.kind, status: tx.status, money: tx.money.toJSON(),
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
  } };
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const event = new WagerTransactionProcessed(wagerProps(tx, ctx, 'PROCESSED'));
    Object.freeze(event);
    return event;
  }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const event = new WagerTransactionRejected(wagerProps(tx, ctx, 'REJECTED'));
    Object.freeze(event);
    return event;
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const event = new WagerTransactionPendingReference(wagerProps(tx, ctx, 'PENDING_REFERENCE'));
    Object.freeze(event);
    return event;
  }
}
export interface WalletBalanceChangedData {
  walletId: string; transactionId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged'; readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (!entry.money.isPositive() || wallet.id !== entry.walletId || wallet.currency !== entry.money.currency || !wallet.balance.equals(entry.balanceAfter) || !entry.isBalanced()) {
      throw new DomainError('INVALID_EVENT_STATE', 'Lançamento incompatível com a wallet.');
    }
    const event = new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data: {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version,
    } });
    Object.freeze(event);
    return event;
  }
}

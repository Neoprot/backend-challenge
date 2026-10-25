import type { UnitOfWork } from '../../shared/application/unit-of-work';
import type { Clock } from '../../shared/domain/clock';
import type { Identifiers } from '../../shared/domain/identifiers';
import { createHash } from 'node:crypto';
import { Money } from '../../shared/domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/ledger-entry';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../messaging/domain/events';

export interface OpenWalletCommand { playerId: string; initialBalance: Money; correlationId: string; }
export class OpenWallet {
  constructor(private readonly uow: UnitOfWork, private readonly clock: Clock, private readonly ids: Identifiers) {}
  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: command.playerId, initialBalance: command.initialBalance, at });
    return this.uow.run(async session => {
      await session.insertWallet(wallet);
      if (wallet.balance.isZero()) return wallet;
      const transaction = WagerTransaction.create({
        id: this.ids.next(), providerId: '__internal__', externalTransactionId: wallet.id,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: createHash('sha256').update(JSON.stringify({ walletId: wallet.id, playerId: wallet.playerId, money: wallet.balance.toJSON() })).digest('hex'),
        walletId: wallet.id, playerId: wallet.playerId, roundId: 'opening', gameId: 'opening',
        kind: 'OPENING', money: wallet.balance, createdAt: at,
      });
      transaction.markProcessed(undefined, at);
      const entry = WalletLedgerEntry.create({
        id: this.ids.next(), walletId: wallet.id, transactionId: transaction.id, direction: 'CREDIT',
        money: wallet.balance, balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance, createdAt: at,
      });
      await session.insertWager(transaction);
      await session.insertLedger(entry);
      await session.enqueue(WagerTransactionProcessed.from(transaction, {
        eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at,
      }));
      await session.enqueue(WalletBalanceChanged.from(wallet, entry, {
        eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at,
      }));
      return wallet;
    });
  }
}

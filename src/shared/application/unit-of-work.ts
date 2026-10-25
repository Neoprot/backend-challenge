import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/ledger-entry';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import type { IntegrationEvent } from '../../messaging/domain/integration-event';

export interface FinancialSession {
  insertWallet(wallet: Wallet): Promise<void>;
  insertWager(transaction: WagerTransaction): Promise<void>;
  insertLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}
export interface UnitOfWork {
  run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}

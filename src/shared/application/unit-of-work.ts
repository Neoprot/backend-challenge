import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/ledger-entry';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import type { IntegrationEvent } from '../../messaging/domain/integration-event';

export interface FinancialSession {
  findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasCompletedReversal(referenceTransactionId: string): Promise<boolean>;
  lockWallet(walletId: string): Promise<Wallet>;
  saveWallet(wallet: Wallet): Promise<void>;
  insertWallet(wallet: Wallet): Promise<void>;
  insertWager(transaction: WagerTransaction): Promise<void>;
  insertLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}
export interface UnitOfWork {
  run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}

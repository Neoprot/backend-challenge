import type { MoneyProps } from '../../shared/domain/money';
import type { LedgerDirection } from '../domain/ledger-entry';

export interface WalletView { id: string; playerId: string; balance: MoneyProps; version: number; }
export interface LedgerView {
  id: string; walletId: string; transactionId: string; direction: LedgerDirection; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; createdAt: string;
}
export interface LedgerPosition { version: 1; walletId: string; createdAt: string; id: string; }
export interface ReconciliationView {
  walletId: string; storedBalance: MoneyProps; calculatedBalance: MoneyProps; difference: MoneyProps;
  consistent: boolean; checkedEntries: number;
}
export interface WalletQueries {
  readWallet(walletId: string): Promise<WalletView | undefined>;
  listLedger(walletId: string, limit: number, position?: LedgerPosition): Promise<LedgerView[]>;
  reconcile(walletId: string): Promise<ReconciliationView | undefined>;
}

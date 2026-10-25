import { Money } from '../../shared/domain/money';
import { DomainError } from '../../shared/domain/domain-error';

export type LedgerDirection = 'DEBIT' | 'CREDIT';
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly #state: Readonly<Omit<LedgerEntryState, 'createdAt'> & { createdAt: number }>;

  private constructor(state: LedgerEntryState) {
    this.#state = Object.freeze({ ...state, createdAt: state.createdAt.getTime() });
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.money.isPositive() || state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER', 'Lançamento exige valor positivo e saldos não negativos.');
    }
    if (!['DEBIT', 'CREDIT'].includes(state.direction)) {
      throw new DomainError('INVALID_LEDGER', 'Direção de lançamento inválida.');
    }
    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced()) throw new DomainError('UNBALANCED_LEDGER', 'Lançamento inconsistente.');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }
  get id() { return this.#state.id; }
  get walletId() { return this.#state.walletId; }
  get transactionId() { return this.#state.transactionId; }
  get direction() { return this.#state.direction; }
  get money() { return this.#state.money; }
  get balanceBefore() { return this.#state.balanceBefore; }
  get balanceAfter() { return this.#state.balanceAfter; }
  get createdAt() { return new Date(this.#state.createdAt); }

  isBalanced(): boolean {
    const calculated = this.direction === 'DEBIT'
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return calculated.equals(this.balanceAfter);
  }
}

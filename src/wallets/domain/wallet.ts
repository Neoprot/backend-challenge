import { Money } from '../../shared/domain/money';
import { DomainError } from '../../shared/domain/domain-error';
import { WalletLedgerEntry, type LedgerDirection } from './ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface MovementContext { transactionId: string; entryId: string; at: Date; }

export class Wallet {
  readonly #id: string;
  readonly #playerId: string;
  readonly #currency: string;
  readonly #createdAt: number;
  #balance: Money;
  #version: number;
  #updatedAt: number;

  private constructor(state: WalletState) {
    this.#id = state.id;
    this.#playerId = state.playerId;
    this.#currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = state.createdAt.getTime();
    this.#updatedAt = state.updatedAt.getTime();
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('NEGATIVE_BALANCE', 'Saldo inicial não pode ser negativo.');
    return new Wallet({ id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at });
  }

  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get id() { return this.#id; }
  get playerId() { return this.#playerId; }
  get currency() { return this.#currency; }
  get balance() { return this.#balance; }
  get version() { return this.#version; }
  get createdAt() { return new Date(this.#createdAt); }
  get updatedAt() { return new Date(this.#updatedAt); }

  debit(money: Money, context: MovementContext): WalletLedgerEntry { return this.move('DEBIT', money, context); }
  credit(money: Money, context: MovementContext): WalletLedgerEntry { return this.move('CREDIT', money, context); }

  private move(direction: LedgerDirection, money: Money, context: MovementContext): WalletLedgerEntry {
    if (money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH', 'Moeda incompatível com a wallet.');
    if (!money.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Movimentação exige valor positivo.');
    if (direction === 'DEBIT' && this.balance.isLessThan(money)) throw new DomainError('INSUFFICIENT_FUNDS', 'Saldo insuficiente.');
    const balanceAfter = direction === 'DEBIT' ? this.balance.subtract(money) : this.balance.add(money);
    const entry = WalletLedgerEntry.create({ id: context.entryId, walletId: this.id, transactionId: context.transactionId,
      direction, money, balanceBefore: this.balance, balanceAfter, createdAt: context.at });
    // Nenhuma mutação ocorre até a construção e validação completa do lançamento.
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = context.at.getTime();
    return entry;
  }
}

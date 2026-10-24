import Decimal from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Dois operandos de até 30 dígitos produzem no máximo 31 dígitos na soma.
const ExactDecimal = Decimal.clone({ precision: 31 });
const maximum = new ExactDecimal('9999999999999999999999999999.99');

export class Money {
  readonly #value: Decimal;
  readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    if (value.abs().greaterThan(maximum)) {
      throw new DomainError('MONEY_OVERFLOW', 'Valor fora do limite NUMERIC(30,2).');
    }
    this.#value = value;
    this.currency = currency;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    return Money.parse(props, false);
  }

  /** Exclusiva para valores persistidos; não aplica regras de transição de negócio. */
  static rehydrate(props: MoneyProps): Money {
    return Money.parse(props, true);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  private static parse(props: MoneyProps, signed: boolean): Money {
    if (!props || typeof props !== 'object' ||
        typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new DomainError('INVALID_MONEY', 'Valor e moeda devem ser strings.');
    }
    const { amount, currency } = props;
    const pattern = signed ? /^-?[0-9]+\.[0-9]{2}$/u : /^[0-9]+\.[0-9]{2}$/u;
    if (amount.trim() !== amount || !pattern.test(amount)) {
      throw new DomainError('INVALID_MONEY', 'Valor deve ter exatamente duas casas decimais e sinal permitido.');
    }
    if (currency.length !== 3 || !/^[A-Z]{3}$/u.test(currency)) {
      throw new DomainError('INVALID_CURRENCY', 'Moeda deve conter três letras maiúsculas.');
    }
    return new Money(new ExactDecimal(amount), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.plus(other.#value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.minus(other.#value), this.currency);
  }

  negate(): Money {
    return new Money(this.#value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return !this.isZero() && this.#value.isPositive();
  }

  isNegative(): boolean {
    return !this.isZero() && this.#value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: this.isZero() ? '0.00' : this.#value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.toJSON().amount + ' ' + this.currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Operações exigem a mesma moeda.');
    }
  }
}

import { expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Money, type MoneyProps } from '../../src/shared/domain/money';
import { DomainError } from '../../src/shared/domain/domain-error';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const maximum = '9999999999999999999999999999.99';

test('soma exata, imutabilidade e serialização', () => {
  const a = brl('0.10');
  const b = brl('0.20');
  expect(a.add(b).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  expect(a.toJSON().amount).toBe('0.10');
  expect(b.toJSON().amount).toBe('0.20');
  expect(Object.isFrozen(a)).toBe(true);
  const props = a.toJSON();
  props.amount = '9.99';
  expect(a.toJSON().amount).toBe('0.10');
  expect(brl('12.30').toString()).toBe('12.30 BRL');
});

test('zero, sinais e diferenças negativas internas', () => {
  const zero = Money.zero('BRL');
  expect(zero.isZero()).toBe(true);
  expect(zero.isPositive()).toBe(false);
  expect(zero.isNegative()).toBe(false);
  expect(zero.negate().toJSON().amount).toBe('0.00');
  expect(brl('0.01').isPositive()).toBe(true);
  expect(brl('0.01').isZero()).toBe(false);
  expect(brl('0.01').isNegative()).toBe(false);
  const difference = brl('0.10').subtract(brl('0.20'));
  expect(difference.toJSON().amount).toBe('-0.10');
  expect(difference.isNegative()).toBe(true);
  expect(difference.isPositive()).toBe(false);
  expect(difference.negate().equals(brl('0.10'))).toBe(true);
  expect(difference.add(brl('0.20')).equals(brl('0.10'))).toBe(true);
  expect(brl('1.00').subtract(brl('1.00')).isZero()).toBe(true);
});

test('comparações e moedas', () => {
  expect(brl('0.10').equals(brl('0.10'))).toBe(true);
  expect(brl('0.10').equals(brl('0.20'))).toBe(false);
  expect(brl('0.10').isLessThan(brl('0.20'))).toBe(true);
  expect(brl('0.20').isLessThan(brl('0.10'))).toBe(false);
  expect(brl('0.10').isLessThan(brl('0.10'))).toBe(false);
  expect(brl('0.10').negate().isLessThan(Money.zero('BRL'))).toBe(true);
  const usd = Money.from({ amount: '0.10', currency: 'USD' });
  expect(usd.toJSON().currency).toBe('USD');
  expect(Money.zero('EUR').toJSON().currency).toBe('EUR');
  for (const operation of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
    expect(() => brl('0.10')[operation](usd)).toThrow(DomainError);
  }
});

test.each(['', ' ', 'NaN', 'Infinity', '-Infinity', '1e2', '0x10', '1', '1.0', '1.001', '.10', '+1.00', '-1.00', '-0.00', ' 1.00', '1.00 ', '1,00'])('rejeita valor inválido: %s', (amount) => {
  expect(() => brl(amount)).toThrow(DomainError);
});

test('rejeita tipos inválidos em runtime', () => {
  for (const props of [null, undefined, {}, { amount: 1, currency: 'BRL' }, { amount: '1.00', currency: 1 }, { amount: {}, currency: 'BRL' }]) {
    expect(() => Money.from(props as MoneyProps)).toThrow(DomainError);
  }
});

test.each(['', 'brl', 'BR', 'BRLL', '123', 'B L'])('rejeita moeda inválida: %s', (currency) => {
  expect(() => Money.from({ amount: '1.00', currency })).toThrow(DomainError);
  expect(() => Money.zero(currency)).toThrow(DomainError);
});

test('precisão acima de MAX_SAFE_INTEGER e isolamento da configuração global', () => {
  expect(brl('9007199254740993.01').add(brl('0.01')).toJSON().amount).toBe('9007199254740993.02');
  expect(brl('9007199254740993.01').subtract(brl('9007199254740993.00')).toJSON().amount).toBe('0.01');
  const previous = Decimal.precision;
  try {
    Decimal.set({ precision: 2 });
    expect(brl(maximum).subtract(brl('0.01')).toJSON().amount).toBe('9999999999999999999999999999.98');
  } finally {
    Decimal.set({ precision: previous });
  }
});

test('limites de NUMERIC(30,2) e overflow positivo e negativo', () => {
  const max = brl(maximum);
  expect(max.toJSON().amount).toBe(maximum);
  expect(max.negate().toJSON().amount).toBe('-' + maximum);
  expect(() => max.add(brl('0.01'))).toThrow(DomainError);
  expect(() => max.negate().subtract(brl('0.01'))).toThrow(DomainError);
  expect(() => brl('10000000000000000000000000000.00')).toThrow(DomainError);
});

test('reidratação explícita aceita negativos persistidos mas preserva invariantes estruturais', () => {
  expect(Money.rehydrate({ amount: '-1.25', currency: 'BRL' }).toJSON().amount).toBe('-1.25');
  expect(() => brl('-1.25')).toThrow(DomainError);
  for (const amount of ['NaN', '-1.001', '-1e2', '-10000000000000000000000000000.00']) {
    expect(() => Money.rehydrate({ amount, currency: 'BRL' })).toThrow(DomainError);
  }
});

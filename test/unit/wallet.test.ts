import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wallets/domain/wallet';
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
const context = { transactionId: 'transaction-1', entryId: 'entry-1', at };
const open = () => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), at });

test('abre com versão 1 e debita sem permitir saldo negativo', () => {
  const wallet = open();
  expect(wallet.version).toBe(1);
  const entry = wallet.debit(money('80.00'), context);
  expect(wallet.balance.toJSON().amount).toBe('20.00');
  expect(wallet.version).toBe(2);
  expect(entry.direction).toBe('DEBIT');
  expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
  expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  expect(() => wallet.debit(money('80.00'), context)).toThrow('Saldo insuficiente');
  expect(wallet.balance.toJSON().amount).toBe('20.00');
  expect(wallet.version).toBe(2);
});
test('crédito mantém lançamento e versão coerentes', () => {
  const wallet = open();
  const entry = wallet.credit(money('25.00'), context);
  expect(wallet.balance.toJSON().amount).toBe('125.00');
  expect(wallet.version).toBe(2);
  expect(entry.direction).toBe('CREDIT');
  expect(entry.isBalanced()).toBe(true);
  expect(entry.walletId).toBe(wallet.id);
});
test('recusa moeda incompatível e valor não positivo sem alterar estado', () => {
  const wallet = open();
  for (const method of ['debit', 'credit'] as const) {
    expect(() => wallet[method](Money.from({ amount: '1.00', currency: 'USD' }), context)).toThrow();
    expect(() => wallet[method](money('0.00'), context)).toThrow();
    expect(() => wallet[method](money('1.00').negate(), context)).toThrow();
  }
  expect(wallet.version).toBe(1);
  expect(wallet.balance.toJSON().amount).toBe('100.00');
});
test('abertura aceita zero, rejeita negativo e reidratação preserva versão', () => {
  expect(Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0.00'), at }).version).toBe(1);
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1.00').negate(), at })).toThrow();
  const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('20.00'), version: 8, createdAt: at, updatedAt: at });
  expect(wallet.version).toBe(8);
  expect(wallet.balance.toJSON().amount).toBe('20.00');
});
test('datas retornadas não permitem modificar estado encapsulado', () => {
  const wallet = open();
  wallet.createdAt.setFullYear(1990);
  wallet.updatedAt.setFullYear(1990);
  expect(wallet.createdAt.toISOString()).toBe(at.toISOString());
  expect(wallet.updatedAt.toISOString()).toBe(at.toISOString());
});
test('overflow de crédito não muda saldo nem versão', () => {
  const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('9999999999999999999999999999.99'), at });
  expect(() => wallet.credit(money('0.01'), context)).toThrow();
  expect(wallet.version).toBe(1);
});

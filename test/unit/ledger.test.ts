import { expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { WalletLedgerEntry } from '../../src/wallets/domain/ledger-entry';
import { DomainError } from '../../src/shared/domain/domain-error';
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const props = { id: 'e', walletId: 'w', transactionId: 't', direction: 'DEBIT' as const, money: money('20.00'), balanceBefore: money('100.00'), balanceAfter: money('80.00'), createdAt: new Date('2026-01-01T00:00:00Z') };
test('lançamento é imutável e verifica sua equação', () => {
  const entry = WalletLedgerEntry.create(props);
  expect(entry.isBalanced()).toBe(true);
  expect(Object.isFrozen(entry)).toBe(true);
  entry.createdAt.setFullYear(1990);
  expect(entry.createdAt.toISOString()).toBe(props.createdAt.toISOString());
});
test('recusa equação inconsistente, saldo negativo, zero e moeda divergente', () => {
  expect(() => WalletLedgerEntry.create({ ...props, balanceAfter: money('81.00') })).toThrow(DomainError);
  expect(() => WalletLedgerEntry.create({ ...props, balanceBefore: money('0.00'), balanceAfter: money('20.00').negate() })).toThrow(DomainError);
  expect(() => WalletLedgerEntry.create({ ...props, money: money('0.00'), balanceAfter: money('100.00') })).toThrow(DomainError);
  expect(() => WalletLedgerEntry.create({ ...props, money: Money.from({ amount: '20.00', currency: 'USD' }) })).toThrow(DomainError);
});
test('reidratação apenas reconstrói o lançamento persistido', () => {
  const entry = WalletLedgerEntry.rehydrate(props);
  expect(entry.id).toBe('e');
  expect(entry.isBalanced()).toBe(true);
});

import { expect, test } from 'bun:test';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged } from '../../src/messaging/domain/events';
import { DomainError } from '../../src/shared/domain/domain-error';
import { WalletLedgerEntry } from '../../src/wallets/domain/ledger-entry';
import { at, money, transaction, wallet } from '../support/wager-fixture';
const ctx = { eventId: 'evt', correlationId: 'corr', causationId: 'cause', occurredAt: at };
test('LOSS produz envelope Processed sem valor monetário não serializável', () => {
  const tx = transaction({ kind: 'LOSS', money: money('0.00') }); tx.markProcessed(undefined, at);
  const event = WagerTransactionProcessed.from(tx, ctx);
  expect(event.toJSON()).toMatchObject({ eventId: 'evt', eventType: 'WagerTransactionProcessed', version: 1, occurredAt: at.toISOString(), data: { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } } });
  const json = event.toJSON(); json.data.money.amount = '9.99';
  expect(event.toJSON().data.money.amount).toBe('0.00');
  expect(Object.isFrozen(event.data.money)).toBe(true);
  event.occurredAt.setFullYear(1990);
  expect(event.occurredAt.toISOString()).toBe(at.toISOString());
});
test('factories exigem estado correspondente', () => {
  const tx = transaction();
  expect(() => WagerTransactionProcessed.from(tx, ctx)).toThrow(DomainError);
  expect(() => WagerTransactionRejected.from(tx, ctx)).toThrow(DomainError);
  expect(() => WagerTransactionPendingReference.from(tx, ctx)).toThrow(DomainError);
  tx.markPendingReference();
  expect(WagerTransactionPendingReference.from(tx, ctx).eventType).toBe('WagerTransactionPendingReference');
  tx.reject('REFERENCE_EXPIRED');
  expect(WagerTransactionRejected.from(tx, ctx).data.failureCode).toBe('REFERENCE_EXPIRED');
});
test('BalanceChanged exige lançamento da wallet e captura saldo/version', () => {
  const w = wallet(); const entry = w.debit(money(), { entryId: 'e', transactionId: 't', at });
  const event = WalletBalanceChanged.from(w, entry, ctx);
  expect(event.toJSON().data).toMatchObject({ walletId: 'w', transactionId: 't', direction: 'DEBIT', balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '80.00' }, walletVersion: 2 });
  expect(() => WalletBalanceChanged.from(wallet(), entry, ctx)).toThrow(DomainError);
});
test('envelope sem causa omite o campo opcional', () => {
  const tx = transaction(); tx.markProcessed(undefined, at);
  const event = WagerTransactionProcessed.from(tx, { eventId: 'e', correlationId: 'c', occurredAt: at });
  expect(Object.hasOwn(event.toJSON(), 'causationId')).toBe(false);
  expect(JSON.parse(JSON.stringify(event)).eventType).toBe('WagerTransactionProcessed');
});
test('BalanceChanged recusa lançamento reidratado sem mudança de saldo', () => {
  const w = wallet();
  const entry = WalletLedgerEntry.rehydrate({ id: 'e', walletId: 'w', transactionId: 't', direction: 'CREDIT', money: money('0.00'), balanceBefore: w.balance, balanceAfter: w.balance, createdAt: at });
  expect(() => WalletBalanceChanged.from(w, entry, ctx)).toThrow(DomainError);
});

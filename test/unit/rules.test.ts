import { expect, test } from 'bun:test';
import { WagerRules } from '../../src/wagering/domain/wager-rules';
import { DomainError } from '../../src/shared/domain/domain-error';
import { money, reference, reversal, transaction, wallet } from '../support/wager-fixture';

test.each([['BET','DEBIT'],['WIN','CREDIT'],['OPENING','CREDIT'],['LOSS',null]] as const)('%s produz direção esperada sem mudar wallet', (kind,direction) => {
  const w = wallet();
  expect(WagerRules.evaluate(transaction({ kind, money: money(kind === 'LOSS' ? '0.00' : '20.00') }), w)).toEqual({ type: 'apply', direction });
  expect(w.version).toBe(1);
});
test('saldo insuficiente distingue aposta de reversão', () => {
  expect(WagerRules.evaluate(transaction(), wallet('10.00'))).toEqual({ type: 'reject', failureCode: 'INSUFFICIENT_FUNDS' });
  expect(WagerRules.evaluate(reversal({ kind: 'ROLLBACK' }), wallet('10.00'), reference({ kind: 'WIN' }))).toEqual({ type: 'reject', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
});
test.each([['BET','CREDIT'],['WIN','DEBIT'],['REFUND','DEBIT']] as const)('ROLLBACK de %s inverte direção', (kind,direction) => {
  const ref = reference({ kind, ...(kind === 'REFUND' ? { referenceExternalTransactionId: 'original' } : {}) });
  expect(WagerRules.evaluate(reversal({ kind: 'ROLLBACK' }), wallet(), ref)).toEqual({ type: 'apply', direction });
});
test('REFUND só permite BET, valor integral e reversão única', () => {
  expect(WagerRules.evaluate(reversal(), wallet(), reference())).toEqual({ type: 'apply', direction: 'CREDIT' });
  expect(WagerRules.evaluate(reversal(), wallet(), reference({ kind: 'WIN' }))).toMatchObject({ type: 'reject', failureCode: 'INVALID_REFERENCE_KIND' });
  expect(WagerRules.evaluate(reversal({ money: money('10.00') }), wallet(), reference())).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
  expect(WagerRules.evaluate(reversal(), wallet(), reference(), true)).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_ALREADY_REVERSED' });
});
test('referência ausente ou pendente aguarda; rejeitada não aplica', () => {
  expect(WagerRules.evaluate(reversal(), wallet())).toEqual({ type: 'wait' });
  const pending = transaction({ externalTransactionId: 'ref-external' });
  expect(WagerRules.evaluate(reversal(), wallet(), pending)).toEqual({ type: 'wait' });
  pending.reject('INSUFFICIENT_FUNDS');
  expect(WagerRules.evaluate(reversal(), wallet(), pending)).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_NOT_PROCESSED' });
});
test.each(['providerId','playerId','walletId','roundId','externalTransactionId'] as const)('referência exige vínculo %s', field => {
  expect(WagerRules.evaluate(reversal(), wallet(), reference({ [field]: 'different' }))).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_MISMATCH' });
});
test('moedas e identidade da wallet são verificadas sem lançar erro técnico', () => {
  expect(WagerRules.evaluate(transaction({ money: money('20.00','USD') }), wallet())).toMatchObject({ type: 'reject', failureCode: 'CURRENCY_MISMATCH' });
  expect(WagerRules.evaluate(reversal(), wallet(), reference({ money: money('20.00','USD') }))).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_MISMATCH' });
  expect(WagerRules.evaluate(transaction({ playerId: 'other' }), wallet())).toMatchObject({ type: 'reject', failureCode: 'WALLET_MISMATCH' });
  expect(WagerRules.evaluate(transaction({ walletId: 'other' }), wallet())).toMatchObject({ type: 'reject', failureCode: 'WALLET_MISMATCH' });
});
test('WIN com referência espera BET e pode ter valor ou gameId diferente', () => {
  const win = transaction({ kind: 'WIN', money: money('50.00'), gameId: 'other-game', referenceExternalTransactionId: 'ref-external' });
  expect(WagerRules.evaluate(win, wallet())).toEqual({ type: 'wait' });
  expect(WagerRules.evaluate(win, wallet(), reference())).toEqual({ type: 'apply', direction: 'CREDIT' });
  expect(WagerRules.evaluate(win, wallet(), reference({ kind: 'WIN' }))).toMatchObject({ type: 'reject', failureCode: 'INVALID_REFERENCE_KIND' });
});
test('ROLLBACK também respeita reversão única e referência FAILED', () => {
  expect(WagerRules.evaluate(reversal({ kind: 'ROLLBACK' }), wallet(), reference(), true)).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_ALREADY_REVERSED' });
  const ref = transaction({ externalTransactionId: 'ref-external' });
  ref.markPendingReference();
  expect(WagerRules.evaluate(reversal(), wallet(), ref)).toEqual({ type: 'wait' });
  ref.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
  expect(WagerRules.evaluate(reversal(), wallet(), ref)).toMatchObject({ type: 'reject', failureCode: 'REFERENCE_NOT_PROCESSED' });
});
test('avaliação recusa transação terminal para impedir reaplicação', () => {
  expect(() => WagerRules.evaluate(reference(), wallet())).toThrow(DomainError);
});

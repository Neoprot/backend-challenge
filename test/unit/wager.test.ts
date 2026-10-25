import { expect, test } from 'bun:test';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { DomainError } from '../../src/shared/domain/domain-error';
import { at, money, props, transaction } from '../support/wager-fixture';

test('nasce pendente e encapsula datas e payload', () => {
  const tx = transaction();
  expect(tx.status).toBe('PENDING');
  expect(tx.isTerminal()).toBe(false);
  expect(tx.matchesPayload('hash')).toBe(true);
  expect(tx.matchesPayload('other')).toBe(false);
  tx.createdAt.setFullYear(1990);
  expect(tx.createdAt.toISOString()).toBe(at.toISOString());
});
test.each(['PROCESSED', 'REJECTED', 'FAILED'] as const)('terminal %s recusa transições', status => {
  const tx = transaction();
  tx.markPendingReference();
  if (status === 'PROCESSED') tx.markProcessed('ref', at);
  else if (status === 'REJECTED') tx.reject('INSUFFICIENT_FUNDS');
  else tx.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
  expect(tx.status).toBe(status);
  expect(tx.isTerminal()).toBe(true);
  for (const transition of [() => tx.markProcessed(undefined, at), () => tx.markPendingReference(), () => tx.reject('INSUFFICIENT_FUNDS'), () => tx.fail('PERMANENT_INFRASTRUCTURE_FAILURE')]) expect(transition).toThrow(DomainError);
});
test('referência obrigatória, autorreferência e valores inválidos', () => {
  for (const kind of ['REFUND', 'ROLLBACK'] as const) expect(() => transaction({ kind })).toThrow(DomainError);
  expect(() => transaction({ kind: 'WIN', referenceExternalTransactionId: 'external' })).toThrow(DomainError);
  expect(() => transaction({ kind: 'LOSS' })).toThrow(DomainError);
  expect(() => transaction({ money: money('0.00') })).toThrow(DomainError);
  expect(() => transaction({ money: money().negate() })).toThrow(DomainError);
});
test('reidratação reconstrói sem reaplicar regra de criação', () => {
  const tx = WagerTransaction.rehydrate({ ...props({ kind: 'REFUND' }), status: 'PROCESSED', referenceTransactionId: 'ref', processedAt: at });
  expect(tx.status).toBe('PROCESSED');
  expect(tx.referenceTransactionId).toBe('ref');
  tx.processedAt!.setFullYear(1990);
  expect(tx.processedAt!.toISOString()).toBe(at.toISOString());
});
test('LOSS não afeta saldo e reversões exigem referência', () => {
  const loss = transaction({ kind: 'LOSS', money: money('0.00') });
  expect(loss.affectsBalance()).toBe(false);
  expect(loss.ledgerDirectionFor()).toBeNull();
  expect(loss.requiresReference()).toBe(false);
  expect(transaction({ kind: 'ROLLBACK', referenceExternalTransactionId: 'ref' }).requiresReference()).toBe(true);
});
test.each(['REFUND','ROLLBACK','WIN'] as const)('%s com referência não conclui sem referência interna resolvida', kind => {
  const tx = transaction({ kind, referenceExternalTransactionId: 'ref' });
  expect(() => tx.markProcessed(undefined, at)).toThrow(DomainError);
  expect(tx.status).toBe('PENDING');
  expect(tx.processedAt).toBeUndefined();
  tx.markPendingReference();
  expect(() => tx.markProcessed(undefined, at)).toThrow(DomainError);
  expect(tx.status).toBe('PENDING_REFERENCE');
  tx.markProcessed('internal-ref', at);
  expect(tx.referenceTransactionId).toBe('internal-ref');
});

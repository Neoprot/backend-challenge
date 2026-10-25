import { test, expect } from 'bun:test';
import { canonicalPayload } from '../../src/wagering/application/canonical-payload';
import { processingResponse } from '../../src/wagering/application/processing-result';
import { DomainError } from '../../src/shared/domain/domain-error';
const payload = () => ({ providerId: 'aurora', externalTransactionId: 'external', playerId: '00000000-0000-4000-8000-000000000001', walletId: '00000000-0000-4000-8000-000000000002', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } });
test('canonicalização ignora ordem e metadados de transporte', () => {
 const p = payload(); const reverse = Object.fromEntries(Object.entries(p).reverse()); reverse.money = { currency: 'BRL', amount: '25.00' };
 expect(canonicalPayload(p).hash).toBe(canonicalPayload({ ...reverse, correlationId: 'x', messageId: 'm', headers: { a: 'b' }, idempotencyKey: 'k' }).hash);
 expect(canonicalPayload(p).hash).toMatch(/^[a-f0-9]{64}$/);
});
test.each(['providerId','externalTransactionId','playerId','walletId','roundId','gameId','kind','money','referenceExternalTransactionId'])('hash inclui %s', key => {
 const p = payload(); const values: Record<string, unknown> = { providerId: 'other', externalTransactionId: 'other', playerId: crypto.randomUUID(), walletId: crypto.randomUUID(), roundId: 'other', gameId: 'other', kind: 'WIN', money: { amount: '26.00', currency: 'BRL' }, referenceExternalTransactionId: 'origin' };
 expect(canonicalPayload({ ...p, [key]: values[key] }).hash).not.toBe(canonicalPayload(p).hash);
});
test.each([null, {}, { kind: 'OPENING' }, { playerId: 'bad' }, { providerId: ' ' }, { externalTransactionId: 'a'.repeat(201) }, { money: { amount: 25, currency: 'BRL' } }, { money: { amount: '25.001', currency: 'BRL' } }, { referenceExternalTransactionId: null }, { kind: 'LOSS' }, { kind: 'REFUND' }])('valida contrato antes de canonicalizar %#', override => {
 const input = override === null ? null : Object.keys(override).length === 0 ? {} : { ...payload(), ...override };
 expect(() => canonicalPayload(input)).toThrow(DomainError);
});
test('resultado de replay preserva snapshot e não altera persistido', () => {
 const result = { transactionId: 'id', status: 'PROCESSED' as const, httpStatus: 200, terminal: true, balance: { amount: '75.00', currency: 'BRL' } };
 const replay = processingResponse(result, true);
 expect(replay).toEqual({ ...result, idempotentReplay: true });
 replay.balance!.amount = '0.00'; expect(result.balance.amount).toBe('75.00');
 expect(processingResponse(result, false).idempotentReplay).toBe(false);
});

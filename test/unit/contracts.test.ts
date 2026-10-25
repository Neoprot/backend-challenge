import { expect, test } from 'bun:test';
import { ledgerLimit, encodeLedgerCursor, decodeLedgerCursor } from '../../src/wallets/application/ledger-cursor';
import { ApplicationError } from '../../src/shared/application/application-error';
const walletId = '00000000-0000-4000-8000-000000000001';
const position = { version: 1 as const, walletId, createdAt: '2026-10-25T12:00:00.123456Z', id: '00000000-0000-4000-8000-000000000002' };
test('limite do ledger usa padrão 50 e aceita extremos', () => {
  expect(ledgerLimit(undefined)).toBe(50); expect(ledgerLimit(1)).toBe(1); expect(ledgerLimit(100)).toBe(100);
});
test.each([0, 101, -1, 1.5, NaN, Infinity, '50', null, {}])('recusa limite inválido %#', value => {
  expect(() => ledgerLimit(value)).toThrow(ApplicationError);
});
test('cursor opaco preserva versão, vínculo, UUID e microssegundos', () => {
  const cursor = encodeLedgerCursor(position); expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeLedgerCursor(cursor, walletId)).toEqual(position);
});
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
test.each(['', '!', 'a'.repeat(2049), 'eyJhIjoxfQ==', encoded(null), encoded([]), encoded({}),
  encoded({ ...position, version: 2 }), encoded({ ...position, id: 'invalid' }),
  encoded({ ...position, createdAt: '2026-02-30T12:00:00.123456Z' }),
  encoded({ ...position, createdAt: '0000-10-25T12:00:00.123456Z' }),
  encoded({ ...position, createdAt: '2026-10-25 12:00:00' }), encoded({ ...position, extra: true }),
])('recusa cursor malformado %#', cursor => {
  expect(() => decodeLedgerCursor(cursor, walletId)).toThrow(ApplicationError);
});
test('cursor de outra carteira é inválido', () => {
  expect(() => decodeLedgerCursor(encoded(position), crypto.randomUUID())).toThrow(ApplicationError);
});

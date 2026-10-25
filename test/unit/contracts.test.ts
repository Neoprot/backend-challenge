import { expect, test } from 'bun:test';
import { openWalletContract, wagerContract, uuidContract, ledgerQuery, correlationId } from '../../src/http/contracts';
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

const id = 'A1234567-1234-1234-1234-123456789ABC';
const wallet = { playerId: id, initialBalance: { amount: '100.00', currency: 'BRL' } };
const wager = { providerId: 'provider', externalTransactionId: 'tx', playerId: id, walletId: id,
  roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };

test('contratos normalizam UUID e convertem somente dinheiro validado', () => {
  const result = openWalletContract(wallet);
  expect(result.playerId).toBe(id.toLowerCase());
  expect(result.initialBalance.toJSON()).toEqual(wallet.initialBalance);
  expect(uuidContract(id)).toBe(id.toLowerCase());
  expect(wagerContract(wager)).toMatchObject({ walletId: id.toLowerCase(), playerId: id.toLowerCase(), kind: 'BET' });
});

test('contratos rejeitam objetos desconhecidos e entradas sem coerção', () => {
  for (const value of [null, [], 'x', { ...wallet, extra: true }, { ...wallet, playerId: 'invalid' },
    { ...wallet, initialBalance: { ...wallet.initialBalance, extra: true } },
    { ...wallet, initialBalance: { amount: 1, currency: 'BRL' } }]) {
    expect(() => openWalletContract(value)).toThrow();
  }
  for (const value of [null, [], { ...wager, kind: 'OPENING' }, { ...wager, kind: 'bet' },
    { ...wager, extra: true }, { ...wager, providerId: 'x'.repeat(121) },
    { ...wager, externalTransactionId: 'x'.repeat(201) }, { ...wager, roundId: '' },
    { ...wager, money: { ...wager.money, extra: true } }, { ...wager, referenceExternalTransactionId: null }]) {
    expect(() => wagerContract(value)).toThrow();
  }
});

test('query de ledger aceita inteiro decimal estrito e valida campos desconhecidos', () => {
  expect(ledgerQuery({})).toEqual({});
  expect(ledgerQuery({ limit: '100', cursor: 'abc' })).toEqual({ limit: 100, cursor: 'abc' });
  for (const limit of ['1e2', '1.0', ' 1', '+1', '0', '101', ['1'], 1]) expect(() => ledgerQuery({ limit })).toThrow();
  expect(() => ledgerQuery({ other: '1' })).toThrow();
});

test('correlação preserva somente identificadores seguros e gera UUID para inválidos', () => {
  expect(correlationId('request-123:abc')).toBe('request-123:abc');
  for (const value of [undefined, '', 'unsafe value', '<script>', 'x'.repeat(129), ['abc']]) {
    expect(correlationId(value)).toMatch(/^[0-9a-f-]{36}$/u);
  }
});

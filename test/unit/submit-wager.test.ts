import { expect, test } from 'bun:test';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import type { IdempotentUnitOfWork } from '../../src/wagering/application/idempotency';
import type { FinancialSession } from '../../src/shared/application/unit-of-work';
import { Wallet } from '../../src/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';

const at = new Date('2026-10-25T12:00:00.000Z');
const walletId = '00000000-0000-4000-8000-000000000001', playerId = '00000000-0000-4000-8000-000000000002';
const payload = { providerId: 'aurora', externalTransactionId: 'external', walletId, playerId, roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
const context = { idempotencyKey: 'key', correlationId: 'correlation', causationId: 'message' };
function fixture(failures: number, code = '40P01', reference?: WagerTransaction, reversed = false) {
  const transactions: WagerTransaction[] = [], waits: number[] = [], statuses: string[] = [], actions: string[] = [];
  let sequence = 0;
  const uow: IdempotentUnitOfWork = { runIdempotent: async (tx, work, options) => {
    transactions.push(tx); statuses.push(tx.status); expect(options?.lockWallet).toBe(true);
    const wallet = Wallet.open({ id: walletId, playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), at });
    const session: FinancialSession = {
      findReference: async (provider, external) => { actions.push(`reference:${provider}:${external}`); return reference; },
      hasCompletedReversal: async id => { actions.push(`reversed:${id}`); return reversed; },
      lockWallet: async () => { actions.push('lock'); return wallet; },
      saveWallet: async () => { actions.push('save'); }, insertWallet: async () => {}, insertWager: async () => {},
      insertLedger: async () => { actions.push('ledger'); }, enqueue: async event => { actions.push(event.eventType); },
    };
    const result = await work(session);
    if (transactions.length <= failures) throw Object.assign(new Error('Falha transitória'), { code });
    return { ...result, idempotentReplay: false };
  } };
  const service = new SubmitWager(uow, { now: () => at }, { next: () => `id-${++sequence}` }, async ms => { waits.push(ms); });
  return { service, transactions, waits, statuses, actions };
}
test('retry reconstrói transação pendente e conserva identidade e aceitação', async () => {
  const f = fixture(1); const result = await f.service.execute(payload, context);
  expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
  expect(f.transactions).toHaveLength(2); expect(f.statuses).toEqual(['PENDING', 'PENDING']);
  expect(f.transactions[0]).not.toBe(f.transactions[1]);
  expect(f.transactions[0]!.id).toBe(f.transactions[1]!.id);
  expect(f.transactions[0]!.createdAt).toEqual(f.transactions[1]!.createdAt);
  expect(f.waits).toHaveLength(1); expect(f.actions[0]).toBe('lock');
});
test.each(['40001', '55P03', '57014'])('limita retry para SQLSTATE %s e retorna 503', async code => {
  const f = fixture(99, code); let error: unknown;
  try { await f.service.execute(payload, context); } catch (e) { error = e; }
  expect(error).toMatchObject({ code: 'PROCESSING_UNAVAILABLE', httpStatus: 503 });
  expect(f.transactions).toHaveLength(3); expect(f.waits).toHaveLength(2);
});
test('falha permanente não causa retry', async () => {
  const f = fixture(99, '23514'); let error: unknown;
  try { await f.service.execute(payload, context); } catch (e) { error = e; }
  expect(error).toMatchObject({ code: '23514' }); expect(f.transactions).toHaveLength(1); expect(f.waits).toHaveLength(0);
});
test.each(['', ' ', 'x'.repeat(321)])('key inválida é recusada antes da unidade transacional %#', async key => {
  const f = fixture(0); let error: unknown;
  try { await f.service.execute(payload, { ...context, idempotencyKey: key }); } catch (e) { error = e; }
  expect(error).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' }); expect(f.transactions).toHaveLength(0);
});
test('erro com code não textual mantém a causa original sem retry', async () => {
  const original = { code: 42 }, waits: number[] = [];
  const uow: IdempotentUnitOfWork = { runIdempotent: async () => { throw original; } };
  const service = new SubmitWager(uow, { now: () => at }, { next: () => 'id' }, async ms => { waits.push(ms); });
  let received: unknown;
  try { await service.execute(payload, context); } catch (error) { received = error; }
  expect(received).toBe(original); expect(waits).toHaveLength(0);
});

test.each([false, true])('resolução fornece referência e reversão concluída=%s às regras', async reversed => {
  const reference = WagerTransaction.create({ ...payload, kind: 'BET', id: 'original',
    idempotencyKey: 'original-key', payloadHash: 'a'.repeat(64), money: Money.from(payload.money), createdAt: at });
  reference.markProcessed(undefined, at);
  const f = fixture(0, '40P01', reference, reversed);
  const result = await f.service.execute({ ...payload, kind: 'REFUND', externalTransactionId: 'refund', referenceExternalTransactionId: 'external' }, context);
  expect(result).toMatchObject(reversed ? { status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' }
    : { status: 'PROCESSED', balance: { amount: '125.00', currency: 'BRL' } });
  expect(f.actions).toContain('reference:aurora:external');
  expect(f.actions).toContain('reversed:original');
  if (!reversed) expect(f.transactions[0]!.referenceTransactionId).toBe('original');
});

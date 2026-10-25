import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { WalletRecord, WagerRecord, LedgerRecord, OutboxRecord } from '../../src/persistence/records';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
import { referenceFixture } from '../support/reference-fixture';

let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(); const migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

test.each(['REFUND', 'ROLLBACK'])('%s de BET restaura saldo e persiste referência interna', async kind => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '25.00');
  const original = await f.service.execute(bet, f.context());
  const reversal = await f.service.execute(f.command(kind, '25.00', bet.externalTransactionId), f.context());
  expect(reversal).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
  const em = orm.em.fork();
  expect(await em.findOneOrFail(WagerRecord, { id: reversal.transactionId })).toMatchObject({ referenceTransactionId: original.transactionId });
  expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '100.00', version: 3 });
  expect(await em.count(LedgerRecord, { walletId: f.wallet.id })).toBe(3);
  await assertLedger(orm, f.wallet.id);
});

test('ROLLBACK de WIN debita; WIN com referência BET permite valor diferente', async () => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '25.00');
  await f.service.execute(bet, f.context());
  const win = f.command('WIN', '10.00', bet.externalTransactionId, { gameId: 'outro-jogo' });
  const won = await f.service.execute(win, f.context());
  expect(won).toMatchObject({ status: 'PROCESSED', balance: { amount: '85.00', currency: 'BRL' } });
  const reversed = await f.service.execute(f.command('ROLLBACK', '10.00', win.externalTransactionId), f.context());
  expect(reversed).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
  await assertLedger(orm, f.wallet.id);
});

test('ROLLBACK de REFUND não reabre direito de reverter BET original', async () => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '25.00');
  await f.service.execute(bet, f.context());
  const refund = f.command('REFUND', '25.00', bet.externalTransactionId);
  await f.service.execute(refund, f.context());
  expect(await f.service.execute(f.command('ROLLBACK', '25.00', refund.externalTransactionId), f.context()))
    .toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
  expect(await f.service.execute(f.command('ROLLBACK', '25.00', bet.externalTransactionId), f.context()))
    .toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(4);
  await assertLedger(orm, f.wallet.id);
});

test('reversão parcial rejeitada não consome direito da reversão integral', async () => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '25.00');
  await f.service.execute(bet, f.context());
  const rejected = await f.service.execute(f.command('REFUND', '10.00', bet.externalTransactionId), f.context());
  expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_AMOUNT_MISMATCH', balance: { amount: '75.00', currency: 'BRL' } });
  expect(await f.service.execute(f.command('ROLLBACK', '25.00', bet.externalTransactionId), f.context()))
    .toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(3);
  await assertLedger(orm, f.wallet.id);
});

test.each([['WIN', '10.00', 'REFUND'], ['LOSS', '0.00', 'ROLLBACK']] as const)('%s de valor %s recusa tipo de reversão proibido', async (kind, amount, reversal) => {
  const f = await referenceFixture(orm); const original = f.command(kind, amount);
  await f.service.execute(original, f.context());
  const before = await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id });
  expect(await f.service.execute(f.command(reversal, amount === '0.00' ? '1.00' : amount, original.externalTransactionId), f.context()))
    .toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND' });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(before);
  await assertLedger(orm, f.wallet.id);
});

test.each([['REFUND', 'REFUND'], ['REFUND', 'ROLLBACK'], ['ROLLBACK', 'REFUND'], ['ROLLBACK', 'ROLLBACK']] as const)
  ('%s concluído impede segunda reversão %s da mesma BET', async (firstKind, secondKind) => {
    const f = await referenceFixture(orm); const bet = f.command('BET', '25.00');
    await f.service.execute(bet, f.context());
    expect(await f.service.execute(f.command(firstKind, '25.00', bet.externalTransactionId), f.context()))
      .toMatchObject({ status: 'PROCESSED' });
    expect(await f.service.execute(f.command(secondKind, '25.00', bet.externalTransactionId), f.context()))
      .toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(3);
    await assertLedger(orm, f.wallet.id);
  });

test('referência rejeitada não pode ser revertida', async () => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '101.00');
  await f.service.execute(bet, f.context());
  expect(await f.service.execute(f.command('REFUND', '101.00', bet.externalTransactionId), f.context()))
    .toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

test('ausente e pendente aguardam; replay não duplica evento e prazo persiste desde aceitação', async () => {
  const f = await referenceFixture(orm); const win = f.command('WIN', '10.00', f.ids.next()); const ctx = f.context();
  const first = await f.service.execute(win, ctx);
  expect(first).toMatchObject({ status: 'PENDING_REFERENCE', httpStatus: 202, terminal: false });
  expect(first.balance).toBeUndefined();
  expect(await f.service.execute(win, ctx)).toEqual({ ...first, idempotentReplay: true });
  expect(await f.service.execute(f.command('ROLLBACK', '10.00', win.externalTransactionId), f.context()))
    .toMatchObject({ status: 'PENDING_REFERENCE', httpStatus: 202 });
  const em = orm.em.fork(); const stored = await em.findOneOrFail(WagerRecord, { id: first.transactionId });
  expect(stored).toMatchObject({ referenceDeadline: new Date(f.at.getTime() + 86400000), nextAttemptAt: new Date(f.at.getTime() + 1000), attempts: 0 });
  expect(await em.count(OutboxRecord, { aggregateId: first.transactionId, eventType: 'WagerTransactionPendingReference' })).toBe(1);
  expect(await em.count(LedgerRecord, { walletId: f.wallet.id })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

test.each(['roundId', 'walletId', 'playerId', 'currency', 'providerId'] as const)('referência com divergência %s não movimenta saldo', async field => {
  const f = await referenceFixture(orm); const bet = f.command('BET', '25.00'); await f.service.execute(bet, f.context());
  const other = await referenceFixture(orm);
  const overrides = field === 'walletId' ? { walletId: other.wallet.id, playerId: other.wallet.playerId }
    : field === 'playerId' ? { playerId: f.ids.next() }
    : field === 'currency' ? { money: { amount: '25.00', currency: 'USD' } }
    : { [field]: field === 'providerId' ? 'horizonte' : 'outra-rodada' };
  const response = await f.service.execute(f.command('REFUND', '25.00', bet.externalTransactionId, overrides), f.context());
  expect(response).toMatchObject(field === 'providerId' ? { status: 'PENDING_REFERENCE' }
    : { status: 'REJECTED', failureCode: field === 'playerId' ? 'WALLET_MISMATCH' : field === 'currency' ? 'CURRENCY_MISMATCH' : 'REFERENCE_MISMATCH' });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(2);
  expect(await orm.em.fork().count(LedgerRecord, { walletId: other.wallet.id })).toBe(1);
  await assertLedger(orm, f.wallet.id); await assertLedger(orm, other.wallet.id);
});

test('autorreferência é inválida antes de persistir a transação', async () => {
  const f = await referenceFixture(orm); const command = f.command('REFUND', '25.00');
  let received: unknown;
  try { await f.service.execute({ ...command, referenceExternalTransactionId: command.externalTransactionId }, f.context()); } catch (error) { received = error; }
  expect(received).toMatchObject({ code: 'INVALID_PAYLOAD' });
  expect(await orm.em.fork().count(WagerRecord, { walletId: f.wallet.id })).toBe(1);
  await assertLedger(orm, f.wallet.id);
});

test('ROLLBACK de WIN sem saldo é rejeitado e tentativa posterior pode concluir', async () => {
  const f = await referenceFixture(orm, '0.00'); const win = f.command('WIN', '10.00');
  await f.service.execute(win, f.context()); await f.service.execute(f.command('BET', '10.00'), f.context());
  const rejected = await f.service.execute(f.command('ROLLBACK', '10.00', win.externalTransactionId), f.context());
  expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '0.00', currency: 'BRL' } });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(2);
  await f.service.execute(f.command('WIN', '10.00'), f.context());
  expect(await f.service.execute(f.command('ROLLBACK', '10.00', win.externalTransactionId), f.context()))
    .toMatchObject({ status: 'PROCESSED', balance: { amount: '0.00', currency: 'BRL' } });
  expect(await orm.em.fork().count(LedgerRecord, { walletId: f.wallet.id })).toBe(4);
  await assertLedger(orm, f.wallet.id);
});

import { beforeAll, afterAll, expect, test } from 'bun:test';
import { createOrm } from '../../src/persistence/orm';
import { testEnvironment } from '../support/environment';
const env = testEnvironment();
let migration: Awaited<ReturnType<typeof createOrm>>;
let app: Awaited<ReturnType<typeof createOrm>>;
const id = () => crypto.randomUUID();

async function expectSqlState(operation: Promise<unknown>, expected: string) {
  let received: unknown;
  try { await operation; }
  catch (error) { received = (error as { code?: string }).code; }
  expect(received).toBe(expected);
}

beforeAll(async () => {
  migration = await createOrm(env.migrationDatabaseUrl);
  await migration.migrator.up();
  app = await createOrm(env.databaseUrl);
});
afterAll(async () => { await app?.close(true); await migration?.close(true); });

test('migrations criam as cinco tabelas financeiras', async () => {
  for (const table of ['wallet', 'wager_transaction', 'wallet_ledger_entry', 'inbox_message', 'outbox_message']) {
    const rows = await app.em.getConnection().execute<{ name: string | null }[]>('select to_regclass(?)::text as name', [table]);
    expect(rows[0]?.name).toBe(table);
  }
});

async function insertWallet() {
  const walletId = id(); const playerId = id();
  await app.em.getConnection().execute('insert into wallet (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, 1, now(), now())', [walletId, playerId, 'BRL', '100.00']);
  return { walletId, playerId };
}
async function insertTransaction(walletId: string, playerId: string, overrides: Record<string, string> = {}) {
  const transactionId = id();
  const fields = { id: transactionId, provider_id: 'aurora', external_transaction_id: id(), idempotency_key: id(), payload_hash: 'a'.repeat(64), wallet_id: walletId, player_id: playerId, round_id: 'round', game_id: 'game', kind: 'BET', currency: 'BRL', amount: '20.00', status: 'PROCESSED', ...overrides };
  const columns = Object.keys(fields);
  await app.em.getConnection().execute(`insert into wager_transaction (${columns.join(',')},created_at,processed_at) values (${columns.map(() => '?').join(',')},now(),now())`, Object.values(fields));
  return transactionId;
}

test('banco recusa saldo negativo e wallet duplicada', async () => {
  const { walletId, playerId } = await insertWallet();
  await expectSqlState(app.em.getConnection().execute('update wallet set balance = -0.01 where id = ?', [walletId]), '23514');
  await expectSqlState(app.em.getConnection().execute('insert into wallet (id,player_id,currency,balance,version,created_at,updated_at) values (?,?,?,0,1,now(),now())', [id(), playerId, 'BRL']), '23505');
});

test('unicidade de idempotência e identidade externa existe no banco', async () => {
  const { walletId, playerId } = await insertWallet();
  const external = id(); const key = id();
  await insertTransaction(walletId, playerId, { external_transaction_id: external, idempotency_key: key });
  await expectSqlState(insertTransaction(walletId, playerId, { external_transaction_id: external }), '23505');
  await expectSqlState(insertTransaction(walletId, playerId, { idempotency_key: key }), '23505');
});

test('ledger exige equação, moeda, unicidade e não permite mutação', async () => {
  const { walletId, playerId } = await insertWallet();
  const transactionId = await insertTransaction(walletId, playerId);
  const sql = 'insert into wallet_ledger_entry (id,wallet_id,transaction_id,direction,currency,amount,balance_before,balance_after,created_at) values (?,?,?,?,?,?,?,?,now())';
  await expectSqlState(app.em.getConnection().execute(sql, [id(),walletId,transactionId,'DEBIT','BRL','20.00','100.00','81.00']), '23514');
  await expectSqlState(app.em.getConnection().execute(sql, [id(),walletId,transactionId,'DEBIT','USD','20.00','100.00','80.00']), '23503');
  const entryId = id();
  await app.em.getConnection().execute(sql, [entryId,walletId,transactionId,'DEBIT','BRL','20.00','100.00','80.00']);
  await expectSqlState(app.em.getConnection().execute(sql, [id(),walletId,transactionId,'DEBIT','BRL','20.00','100.00','80.00']), '23505');
  await expectSqlState(app.em.getConnection().execute('update wallet_ledger_entry set amount = 1 where id = ?', [entryId]), '42501');
  await expectSqlState(app.em.getConnection().execute('delete from wallet_ledger_entry where id = ?', [entryId]), '42501');
  await expectSqlState(app.em.getConnection().execute('truncate wallet_ledger_entry'), '42501');
  // Mesmo a role dona das tabelas deve respeitar os triggers de imutabilidade.
  await expectSqlState(migration.em.getConnection().execute('delete from wallet_ledger_entry where id = ?', [entryId]), '55000');
});

test('REFUND e ROLLBACK não podem concluir sobre a mesma referência', async () => {
  const { walletId, playerId } = await insertWallet();
  const referenceId = await insertTransaction(walletId, playerId);
  await insertTransaction(walletId, playerId, { kind: 'REFUND', reference_transaction_id: referenceId, reference_external_transaction_id: 'ref' });
  await expectSqlState(insertTransaction(walletId, playerId, { kind: 'ROLLBACK', reference_transaction_id: referenceId, reference_external_transaction_id: 'ref' }), '23505');
  // Uma tentativa rejeitada não reserva a referência nem impede auditoria.
  await insertTransaction(walletId, playerId, { kind: 'ROLLBACK', status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED', reference_transaction_id: referenceId, reference_external_transaction_id: 'ref' });
});

test('inbox impõe identidade composta e migrations são reversíveis', async () => {
  const messageId = id();
  const sql = 'insert into inbox_message (consumer_name,message_id,payload_hash,received_at) values (?,?,?,now())';
  await app.em.getConnection().execute(sql, ['wager-consumer',messageId,'b'.repeat(64)]);
  await expectSqlState(app.em.getConnection().execute(sql, ['wager-consumer',messageId,'b'.repeat(64)]), '23505');
  await migration.migrator.down({ to: 0 });
  const rows = await migration.em.getConnection().execute<{ name: string | null }[]>('select to_regclass(?)::text as name', ['wallet']);
  expect(rows[0]?.name).toBeNull();
  await migration.migrator.up();
  const restored = await app.em.getConnection().execute<{ name: string | null }[]>('select to_regclass(?)::text as name', ['wallet']);
  expect(restored[0]?.name).toBe('wallet');
});

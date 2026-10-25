import { beforeAll, afterAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../src/bootstrap/main';
import { createOrm } from '../../src/persistence/orm';
import { testEnvironment } from '../support/environment';
import { accessToken } from '../support/identity';
import { assertLedger } from '../support/assert-ledger';

const environment = testEnvironment();
const configuration = { ...environment, audience: 'wagering-api', port: 3000, region: 'us-east-1' };
let app: INestApplication, orm: MikroORM, base: string;
let providerToken: string, adminToken: string;
beforeAll(async () => {
  providerToken = await accessToken(); adminToken = await accessToken('admin');
  const migrator = await createOrm(environment.migrationDatabaseUrl);
  try { await migrator.migrator.up(); } finally { await migrator.close(true); }
  orm = await createOrm(environment.databaseUrl);
  app = await createApplication(configuration, { lockTimeoutMs: 30 });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { await app?.close(); await orm?.close(true); });

async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (path.startsWith('/wagering/') || path.startsWith('/providers/aurora/') ? providerToken : adminToken), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
}
async function fixture() {
  const playerId = crypto.randomUUID();
  const opened = await request('/wallets', 'POST', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  expect(opened.status).toBe(201);
  const command = (patch: Record<string, unknown> = {}) => ({ providerId: 'aurora', externalTransactionId: crypto.randomUUID(),
    playerId, walletId: opened.body.id, roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, ...patch });
  const submit = (body: unknown, key = crypto.randomUUID()) => request('/wagering/transactions', 'POST', body, { 'Idempotency-Key': key, 'X-Correlation-Id': 'http-correlation' });
  return { playerId, walletId: opened.body.id as string, command, submit };
}

test('HTTP cobre endpoints, status, snapshots e ledger financeiro real', async () => {
  const f = await fixture();
  const original = f.command(), key = crypto.randomUUID();
  const first = await f.submit(original, key);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
  expect((await f.submit(f.command({ kind: 'WIN', money: { amount: '10.00', currency: 'BRL' } }))).status).toBe(200);
  const replay = await f.submit(original, key);
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ ...first.body, idempotentReplay: true });
  const read = await request('/wallets/' + f.walletId.toUpperCase());
  expect(read.status).toBe(200);
  expect(read.body.balance.amount).toBe('85.00');
  const byId = await request('/wagering/transactions/' + first.body.transactionId);
  expect(byId.status).toBe(200);
  expect(byId.body).toMatchObject({ providerId: original.providerId, externalTransactionId: original.externalTransactionId, status: 'PROCESSED', money: original.money,
    result: { balance: { amount: '75.00', currency: 'BRL' } } });
  const external = await request(`/providers/${original.providerId}/wagering/transactions/${original.externalTransactionId}`);
  expect(external.status).toBe(200);
  expect(external.body).toEqual(byId.body);
  const page = await request(`/wallets/${f.walletId}/ledger?limit=1`);
  expect(page.status).toBe(200);
  expect(page.body.items).toHaveLength(1);
  expect(typeof page.body.items[0].money.amount).toBe('string');
  expect((await request(`/wallets/${f.walletId}/ledger?limit=1&cursor=${page.body.nextCursor}`)).body.items).toHaveLength(1);
  const reconciliation = await request(`/wallets/${f.walletId}/reconciliation`, 'POST');
  expect(reconciliation.status).toBe(200);
  expect(reconciliation.body).toMatchObject({ walletId: f.walletId, consistent: true, checkedEntries: 3, difference: { amount: '0.00', currency: 'BRL' } });
  expect((await f.submit(original, crypto.randomUUID())).status).toBe(409);
  expect((await f.submit({ ...original, money: { amount: '1.00', currency: 'BRL' } }, key)).status).toBe(409);
  const rejected = await f.submit(f.command({ money: { amount: '1000.00', currency: 'BRL' } }));
  expect(rejected.status).toBe(422);
  expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect(rejected.body.correlationId).toBe('http-correlation');
  const pending = await f.submit(f.command({ kind: 'REFUND', referenceExternalTransactionId: crypto.randomUUID() }));
  expect(pending.status).toBe(202);
  expect(pending.body.status).toBe('PENDING_REFERENCE');
  expect((await request('/wallets', 'POST', { playerId: f.playerId, initialBalance: { amount: '0.00', currency: 'BRL' } })).status).toBe(409);
  await assertLedger(orm, f.walletId);
});

test('HTTP sanitiza contratos inválidos, JSON, rota, erros e correlação', async () => {
  const f = await fixture();
  expect((await request('/wagering/transactions', 'POST', f.command())).status).toBe(400);
  for (const body of [null, [], { ...f.command(), extra: true }, { ...f.command(), kind: 'OPENING' },
    { ...f.command(), money: { amount: 25, currency: 'BRL' } }, { ...f.command(), money: { amount: '25.00', currency: 'BRL', extra: true } }]) {
    expect((await f.submit(body)).status).toBe(400);
  }
  for (const path of ['/wallets/invalid', `/wallets/${f.walletId}/ledger?limit=1e2`, `/wallets/${f.walletId}/ledger?limit=101`, `/wallets/${f.walletId}/ledger?other=1`]) {
    expect((await request(path)).status).toBe(400);
  }
  for (const path of ['/wallets/' + crypto.randomUUID(), '/wagering/transactions/' + crypto.randomUUID(), '/providers/none/wagering/transactions/none', '/missing']) {
    const error = await request(path, 'GET', undefined, { 'X-Correlation-Id': 'request-safe' });
    expect(error.status).toBe(404);
    expect(error.body.correlationId).toBe('request-safe');
    expect(error.headers.get('x-correlation-id')).toBe('request-safe');
    expect(error.body.stack).toBeUndefined();
  }
  const invalidCorrelation = await request('/missing', 'GET', undefined, { 'X-Correlation-Id': 'unsafe value' });
  expect(invalidCorrelation.body.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
  const malformed = await fetch(base + '/wallets', { method: 'POST', headers: { 'content-type': 'application/json', 'x-correlation-id': 'bad-json', authorization: 'Bearer ' + adminToken }, body: '{broken' });
  expect(malformed.status).toBe(400);
  const malformedBody = await malformed.json() as Record<string, unknown>;
  expect(malformedBody.correlationId).toBe('bad-json');
  expect(JSON.stringify(malformedBody)).not.toContain('broken');
  expect([404, 405]).toContain((await request('/wallets/' + f.walletId, 'DELETE')).status);
  await assertLedger(orm, f.walletId);
});

test('readiness consulta PostgreSQL e SQS reais e distingue liveness', async () => {
  expect((await request('/health/live')).status).toBe(200);
  expect((await request('/health/ready')).status).toBe(200);
  const unavailable = await createApplication({ ...configuration, sqsEndpoint: 'http://127.0.0.1:1' });
  try {
    await unavailable.listen(0, '127.0.0.1');
    const response = await fetch(await unavailable.getUrl() + '/health/ready');
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe('DEPENDENCIES_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    expect((await fetch(await unavailable.getUrl() + '/health/live')).status).toBe(200);
  } finally { await unavailable.close(); }
});

test('HTTP responde 503 após contenção real limitada sem duplicar efeitos', async () => {
  const f = await fixture();
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const blocking = orm.em.fork().transactional(async em => {
    await em.execute('select id from wallet where id = ? for update', [f.walletId]);
    locked(); await gate;
  });
  await ready;
  try {
    const result = await f.submit(f.command());
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('PROCESSING_UNAVAILABLE');
    expect(result.body.correlationId).toBe('http-correlation');
    expect(JSON.stringify(result.body)).not.toContain('select');
  } finally { release(); await blocking; }
  await assertLedger(orm, f.walletId);
});

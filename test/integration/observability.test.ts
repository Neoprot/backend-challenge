import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createApplication } from '../../src/bootstrap/main';
import { createOrm } from '../../src/persistence/orm';
import { testEnvironment } from '../support/environment';
import { accessToken } from '../support/identity';
import { withOutage } from '../support/outage';
import { assertLedger } from '../support/assert-ledger';
import { inboxFixture } from '../support/inbox-fixture';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { ApplicationObservation } from '../../src/observability/observation';
import { PostgresOutboxStore } from '../../src/persistence/outbox-store';
import { OutboxRecord } from '../../src/persistence/records';
import { boundedRead } from '../../src/observability/read-probe';
import { PostgresReferenceStore } from '../../src/persistence/reference-store';
import { ReferenceWorker } from '../../src/workers/reference-worker';
import { WagerRecord } from '../../src/persistence/records';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';

const environment = testEnvironment();
const configuration = { ...environment, audience: 'wagering-api', port: 3000, region: 'us-east-1' };
let app: INestApplication, orm: MikroORM, base: string, admin: string, provider: string;
const lines: string[] = [];
beforeAll(async () => {
  admin = await accessToken('admin'); provider = await accessToken();
  const migrator = await createOrm(environment.migrationDatabaseUrl);
  try { await migrator.migrator.up(); } finally { await migrator.close(true); }
  orm = await createOrm(environment.databaseUrl);
  app = await createApplication(configuration, { lockTimeoutMs: 30, logSink: line => { lines.push(line); } });
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  expect((await fetch(base + '/metrics', { headers: { authorization: 'Bearer ' + admin } })).status).toBe(200);
});
afterAll(async () => { await app?.close(); await orm?.close(true); });
async function request(path: string, method = 'GET', body?: unknown, token = admin) {
  return fetch(base + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-correlation-id': 'observability-test' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function scrape() { const response = await request('/metrics'); expect(response.status).toBe(200); return response.text(); }
function metric(text: string, name: string): number {
  return text.split('\n').filter(line => line.startsWith(name + ' ') || line.startsWith(name + '{')).reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}

test('health público; métricas textuais exigem JWT real de administrador', async () => {
  for (const path of ['/health/live', '/health/ready']) expect((await fetch(base + path)).status).toBe(200);
  expect((await fetch(base + '/metrics')).status).toBe(401);
  expect((await request('/metrics', 'GET', undefined, provider)).status).toBe(403);
  const response = await request('/metrics');
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/plain');
  expect(await response.text()).toContain('wagering_transactions_total');
});

test('commit, replay, rejeição, lock real, outbox e reconciliação produzem sinais sem payload', async () => {
  const baseline = await scrape(), playerId = crypto.randomUUID();
  const opened = await request('/wallets', 'POST', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  expect(opened.status).toBe(201);
  const wallet = await opened.json() as { id: string };
  const command = { providerId: 'aurora', externalTransactionId: crypto.randomUUID(), playerId, walletId: wallet.id,
    roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  const key = crypto.randomUUID();
  const submit = (body: unknown, idempotencyKey: string) => fetch(base + '/wagering/transactions', { method: 'POST', headers: {
    authorization: 'Bearer ' + provider, 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-correlation-id': 'observability-test',
  }, body: JSON.stringify(body) });
  expect((await submit(command, key)).status).toBe(200);
  expect((await submit(command, key)).status).toBe(200);
  expect((await submit({ ...command, externalTransactionId: crypto.randomUUID(), money: { amount: '1000.00', currency: 'BRL' } }, crypto.randomUUID())).status).toBe(422);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
  const blocking = orm.em.fork().transactional(async em => { await em.execute('select id from wallet where id = ? for update', [wallet.id]); locked(); await gate; });
  await ready;
  try { expect((await submit({ ...command, externalTransactionId: crypto.randomUUID() }, crypto.randomUUID())).status).toBe(503); }
  finally { release(); await blocking; }
  const migrator = await createOrm(environment.migrationDatabaseUrl);
  try {
    await migrator.em.fork().execute('update wallet set balance = balance + 1 where id = ?', [wallet.id]);
    expect((await request('/wallets/' + wallet.id + '/reconciliation', 'POST')).status).toBe(200);
  } finally { await migrator.em.fork().execute('update wallet set balance = balance - 1 where id = ?', [wallet.id]); await migrator.close(true); }
  const result = await scrape();
  expect(metric(result, 'wagering_transactions_total') - metric(baseline, 'wagering_transactions_total')).toBe(3);
  expect(metric(result, 'wagering_duplicates_total') - metric(baseline, 'wagering_duplicates_total')).toBe(1);
  expect(metric(result, 'wagering_retries_total') - metric(baseline, 'wagering_retries_total')).toBe(2);
  expect(metric(result, 'wagering_lock_conflicts_total') - metric(baseline, 'wagering_lock_conflicts_total')).toBe(3);
  expect(metric(result, 'wagering_reconciliation_divergences_total') - metric(baseline, 'wagering_reconciliation_divergences_total')).toBe(1);
  expect(metric(result, 'wagering_outbox_lag_seconds')).toBeGreaterThanOrEqual(0);
  const logs = lines.map(line => JSON.parse(line) as Record<string, unknown>);
  expect(logs.some(log => log.event === 'transaction_committed' && log.walletId === wallet.id && log.correlationId === 'observability-test')).toBe(true);
  expect(logs.some(log => log.event === 'reconciliation_divergence' && log.walletId === wallet.id)).toBe(true);
  for (const forbidden of [admin, provider, playerId, '1000.00', '25.00', 'authorization', 'access_token', 'client_secret', 'money', 'balance']) expect(lines.join('\n')).not.toContain(forbidden);
  await assertLedger(orm, wallet.id);
});

for (const service of ['localstack', 'postgres'] as const) {
  test('readiness 503 limitada durante outage real de ' + service + '; liveness permanece 200', async () => {
    await withOutage(service, async () => {
      const start = performance.now();
      expect((await fetch(base + '/health/ready')).status).toBe(503);
      expect(performance.now() - start).toBeLessThan(2300);
      expect((await fetch(base + '/health/live')).status).toBe(200);
      expect((await request('/metrics')).status).toBe(200);
    });
    expect((await fetch(base + '/health/ready')).status).toBe(200);
  }, 180000);
}

test('workers propagam contexto, publicam outbox e contabilizam DLQ somente após aceite SQS', async () => {
  const f = await inboxFixture(orm), observation = app.get(ApplicationObservation), baseline = await scrape();
  const dlq = (await f.sqs.send(new CreateQueueCommand({ QueueName: `obs-dlq-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const events = (await f.sqs.send(new CreateQueueCommand({ QueueName: `obs-events-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const consumer = new SqsConsumer(f.sqs, f.queueUrl, app.get(SubmitWager), f.consumerName, { waitTimeSeconds: 1, dlqUrl: dlq, observation });
  try {
    await f.send(); expect(await consumer.pollOnce()).toBe(1);
    const log = lines.map(line => JSON.parse(line)).find(log => log.event === 'message_completed' && log.messageId === f.envelope.messageId);
    expect(log).toMatchObject({ correlationId: f.envelope.messageId, walletId: f.wallet.id, providerId: 'aurora' });
    const rows = await orm.em.fork().find(OutboxRecord, { aggregateId: f.wallet.id });
    const store = new PostgresOutboxStore(orm), ids = rows.map(row => row.id);
    const scoped = { claim: (options: Parameters<typeof store.claim>[0]) => store.claim({ ...options, ids }), markPublished: store.markPublished.bind(store), fail: store.fail.bind(store) };
    const publisher = new OutboxPublisher(scoped, f.sqs, events, f.ids, undefined, { observation });
    expect(await publisher.pollOnce()).toBe(ids.length);
    expect(lines.map(line => JSON.parse(line)).some(log => log.event === 'outbox_published' && log.walletId === f.wallet.id)).toBe(true);
    await f.send({ authorization: 'worker-secret-authorization', client_secret: 'worker-secret-client', access_token: 'worker-secret-token', money: '929292.92' });
    expect(await consumer.pollOnce()).toBe(1);
    const messages = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1 }));
    expect(messages.Messages).toHaveLength(1);
    expect(metric(await scrape(), 'wagering_dlq_total') - metric(baseline, 'wagering_dlq_total')).toBe(1);
    for (const forbidden of ['worker-secret-', '929292.92', f.wallet.playerId]) expect(lines.join('\n')).not.toContain(forbidden);
    await assertLedger(orm, f.wallet.id);
  } finally {
    await consumer.stop(2000);
    await f.sqs.send(new DeleteQueueCommand({ QueueUrl: dlq })); await f.sqs.send(new DeleteQueueCommand({ QueueUrl: events })); await f.close();
  }
}, 15000);

test('sonda cancela leitura SQL própria longa pela API pública e libera o pool', async () => {
  const start = performance.now(); let failure: unknown;
  try { await boundedRead(orm, 'select pg_sleep(10) /* observability_cancellable_probe */', [], 100); } catch (error) { failure = error; }
  expect(failure).toBeDefined(); expect(performance.now() - start).toBeLessThan(1500);
  let active = '1';
  // O aborto rejeita o await antes do cancelamento assíncrono concluir no servidor.
  for (let attempt = 0; attempt < 20 && active !== '0'; attempt++) {
    active = (await orm.em.fork().execute<{ count: string }[]>("select count(*)::text as count from pg_stat_activity where pid <> pg_backend_pid() and state = 'active' and query like '%observability_cancellable_probe%'"))[0]!.count;
    if (active !== '0') await Bun.sleep(25);
  }
  expect(active).toBe('0');
  expect((await fetch(base + '/health/ready')).status).toBe(200);
});

test('referência aguardando e fence inválido não repetem transição; resolução e FAILED observam commit real', async () => {
  const f = await inboxFixture(orm), submit = app.get(SubmitWager), observation = app.get(ApplicationObservation);
  const baseCommand = { ...f.envelope.data };
  const { idempotencyKey: _key, ...payload } = baseCommand;
  const referenceId = crypto.randomUUID(), context = { idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), causationId: crypto.randomUUID() };
  const result = await submit.execute({ ...payload, kind: 'REFUND', referenceExternalTransactionId: referenceId }, context);
  const pending = await orm.em.fork().findOneOrFail(WagerRecord, { id: result.transactionId });
  const baseline = await scrape(), initialLogs = lines.length;
  let now = new Date(pending.nextAttemptAt!.getTime() + 10);
  const worker = new ReferenceWorker(new PostgresReferenceStore(orm), submit, f.ids, { now: () => now }, { ids: [result.transactionId], observation });
  try {
    expect(await worker.pollOnce()).toBe(1);
    expect(metric(await scrape(), 'wagering_transactions_total')).toBe(metric(baseline, 'wagering_transactions_total'));
    expect(lines.slice(initialLogs).map(line => JSON.parse(line)).filter(log => log.event === 'transaction_committed')).toHaveLength(0);
    await submit.reprocessPending(result.transactionId, crypto.randomUUID());
    expect(metric(await scrape(), 'wagering_transactions_total')).toBe(metric(baseline, 'wagering_transactions_total'));
    await submit.execute({ ...payload, externalTransactionId: referenceId }, { ...context, idempotencyKey: crypto.randomUUID() });
    now = new Date(now.getTime() + 10000);
    expect(await worker.pollOnce()).toBe(1);
    const transition = lines.map(line => JSON.parse(line)).find(log => log.event === 'transaction_committed' && log.component === 'reference' && log.transactionId === result.transactionId);
    expect(transition).toMatchObject({ correlationId: context.correlationId, messageId: context.causationId, status: 'PROCESSED', walletId: f.wallet.id });
    const beforeFailure = await scrape(), eventsBefore = await orm.em.fork().count(OutboxRecord, {});
    const failed = await submit.recordPermanentFailure({ ...payload, externalTransactionId: crypto.randomUUID() }, { ...context, idempotencyKey: crypto.randomUUID() });
    expect(failed.status).toBe('FAILED');
    expect(metric(await scrape(), 'wagering_transactions_total') - metric(beforeFailure, 'wagering_transactions_total')).toBe(1);
    expect(await orm.em.fork().count(OutboxRecord, {})).toBe(eventsBefore);
    expect(lines.map(line => JSON.parse(line)).some(log => log.event === 'transaction_committed' && log.transactionId === failed.transactionId && log.status === 'FAILED')).toBe(true);
    await assertLedger(orm, f.wallet.id);
  } finally { await worker.stop(2000); await f.close(); }
});

test('falhas reais pós-commit e pós-envio preservam contexto individual sem duplicar logs', async () => {
  const f = await inboxFixture(orm), observation = app.get(ApplicationObservation), failure = new Error('password=segredo-pós-commit');
  const consumer = new SqsConsumer(f.sqs, f.queueUrl, app.get(SubmitWager), f.consumerName, {
    waitTimeSeconds: 1, observation, afterCommitBeforeAck: async () => { throw failure; },
  });
  const eventQueue = (await f.sqs.send(new CreateQueueCommand({ QueueName: `obs-failure-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  try {
    const start = lines.length; await f.send();
    let caught: unknown; try { await consumer.pollOnce(); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    const tx = await orm.em.fork().findOneOrFail(WagerRecord, { walletId: f.wallet.id, externalTransactionId: f.envelope.data.externalTransactionId });
    expect(tx.status).toBe('PROCESSED');
    const failures = lines.slice(start).map(line => JSON.parse(line)).filter(log => log.event === 'worker_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ component: 'consumer', messageId: f.envelope.messageId, correlationId: f.envelope.messageId,
      transactionId: tx.id, walletId: f.wallet.id, providerId: 'aurora' });
    const record = await orm.em.fork().findOneOrFail(OutboxRecord, { aggregateId: tx.id });
    const store = new PostgresOutboxStore(orm), scoped = { claim: (options: Parameters<typeof store.claim>[0]) => store.claim({ ...options, ids: [record.id] }),
      markPublished: store.markPublished.bind(store), fail: store.fail.bind(store) };
    const publisher = new OutboxPublisher(scoped, f.sqs, eventQueue, f.ids, undefined, { observation, afterSendBeforePublished: async () => { throw failure; } });
    caught = undefined; try { await publisher.pollOnce(); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: eventQueue, WaitTimeSeconds: 1 }))).Messages).toHaveLength(1);
    const publishedFailures = lines.slice(start).map(line => JSON.parse(line)).filter(log => log.event === 'worker_failed' && log.component === 'publisher');
    expect(publishedFailures).toHaveLength(1);
    expect(publishedFailures[0]).toMatchObject({ messageId: record.id, correlationId: f.envelope.messageId, transactionId: tx.id, walletId: f.wallet.id, providerId: 'aurora' });
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { id: record.id })).publishedAt).toBeNull();
    const { idempotencyKey: _key, ...payload } = f.envelope.data;
    const context = { idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), causationId: crypto.randomUUID() };
    const pending = await app.get(SubmitWager).execute({ ...payload, externalTransactionId: crypto.randomUUID(), kind: 'REFUND', referenceExternalTransactionId: crypto.randomUUID() }, context);
    const pendingRecord = await orm.em.fork().findOneOrFail(WagerRecord, { id: pending.transactionId });
    const failingSubmit = new SubmitWager(new PostgresUnitOfWork(orm, { beforePendingCommit: async () => { throw failure; } }), f.clock, f.ids, undefined, observation);
    const references = new ReferenceWorker(new PostgresReferenceStore(orm), failingSubmit, f.ids, { now: () => new Date(pendingRecord.nextAttemptAt!.getTime() + 10) }, { observation, ids: [pending.transactionId] });
    caught = undefined; try { await references.pollOnce(); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    const referenceFailures = lines.slice(start).map(line => JSON.parse(line)).filter(log => log.event === 'worker_failed' && log.component === 'reference');
    expect(referenceFailures).toHaveLength(1);
    expect(referenceFailures[0]).toMatchObject({ transactionId: pending.transactionId, correlationId: context.correlationId, messageId: context.causationId, walletId: f.wallet.id, providerId: 'aurora' });
    await references.stop(2000);
    expect(lines.slice(start).join('\n')).not.toContain('segredo-pós-commit');
    await assertLedger(orm, f.wallet.id);
  } finally { await consumer.stop(2000); await f.sqs.send(new DeleteQueueCommand({ QueueUrl: eventQueue })); await f.close(); }
}, 15000);

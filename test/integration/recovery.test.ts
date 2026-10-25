import { beforeAll, afterAll, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { PostgresOutboxStore } from '../../src/persistence/outbox-store';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import { createWorkerRuntime } from '../../src/workers/worker-runtime';
import { classifyFailure } from '../../src/workers/worker-lifecycle';
import { InboxRecord, LedgerRecord, OutboxRecord, WagerRecord, WalletRecord } from '../../src/persistence/records';
import { inboxFixture } from '../support/inbox-fixture';
import { testEnvironment } from '../support/environment';
import { withOutage } from '../support/outage';
import { assertLedger } from '../support/assert-ledger';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });
function gate() {
  let release!: () => void, enter!: () => void;
  return { entered: new Promise<void>(r => { enter = r; }), hold: new Promise<void>(r => { release = r; }), release: () => release(), enter: () => enter() };
}

test('heartbeat renova visibilidade real enquanto a SQL está em execução', async () => {
  const f = await inboxFixture(orm), g = gate(); let running: Promise<number> | undefined;
  try {
    await f.sqs.send(new SetQueueAttributesCommand({ QueueUrl: f.queueUrl, Attributes: { VisibilityTimeout: '2' } }));
    const submit = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => { g.enter(); await g.hold; } }), f.clock, f.ids);
    const worker = new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, heartbeatMs: 200 });
    await f.send(); running = worker.pollOnce(); await g.entered;
    await Bun.sleep(2500);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }))).Messages ?? []).toHaveLength(0);
    g.release(); await running; await assertLedger(orm, f.wallet.id);
  } finally { g.release(); await running; await f.close(); }
}, 15000);

test('prazo de drain devolve visibilidade da operação ainda pendente e bloqueia novas buscas', async () => {
  const f = await inboxFixture(orm), g = gate(); let running: Promise<number> | undefined;
  try {
    const submit = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => { g.enter(); await g.hold; } }), f.clock, f.ids);
    const worker = new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, heartbeatMs: 200 });
    await f.send(); running = worker.pollOnce(); await g.entered;
    expect(await worker.stop(20)).toEqual({ drained: false });
    expect(await worker.pollOnce()).toBe(0);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }))).Messages).toHaveLength(1);
    g.release(); await running;
    expect((await orm.em.fork().findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })).status).toBe('PROCESSED');
    await assertLedger(orm, f.wallet.id);
  } finally { g.release(); await running; await f.close(); }
}, 10000);

test('outage real PostgreSQL pausa recebimentos sem FAILED nem consumo artificial das cinco entregas', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.send();
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1, databaseAvailable: async () => {
      try { await orm.em.fork().execute('select 1'); return true; } catch { return false; }
    } });
    await withOutage('postgres', async restore => {
      for (let i = 0; i < 7; i++) expect(await worker.pollOnce()).toBe(0);
      const attrs = await f.sqs.send(new GetQueueAttributesCommand({ QueueUrl: f.queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
      expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('1'); expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
      await restore();
    });
    expect(await worker.pollOnce()).toBe(1);
    const tx = await orm.em.fork().findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('PROCESSED'); expect(tx.failureCode).toBeNull(); await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
}, 90000);

test('outage real SQS mantém outbox SQL e retoma em fila recriada sem alegar persistência do emulador', async () => {
  const f = await inboxFixture(orm), queueName = `outage-${f.ids.next()}.fifo`;
  let output = (await f.sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  try {
    const { idempotencyKey, ...payload } = f.envelope.data;
    await f.submit.execute(payload, { idempotencyKey, correlationId: f.envelope.messageId });
    const tx = await orm.em.fork().findOneOrFail(WagerRecord, { idempotencyKey });
    const store = new PostgresOutboxStore(orm), eventIds = (await orm.em.fork().find(OutboxRecord, { aggregateId: tx.id })).map(row => row.id);
    const publisher = new OutboxPublisher({ claim: options => store.claim({ ...options, ids: eventIds }), markPublished: (...args) => store.markPublished(...args), fail: (...args) => store.fail(...args) }, f.sqs, output, f.ids, undefined, { sendTimeoutMs: 300 });
    await withOutage('localstack', async restore => {
      expect(await publisher.pollOnce()).toBe(0);
      expect((await orm.em.fork().findOneOrFail(OutboxRecord, { aggregateId: tx.id })).publishedAt).toBeNull();
      await restore();
      output = (await f.sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
    });
    await Bun.sleep(1100); expect(await publisher.pollOnce()).toBeGreaterThan(0);
    expect((await orm.em.fork().findOneOrFail(OutboxRecord, { aggregateId: tx.id })).publishedAt).not.toBeNull();
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: output, WaitTimeSeconds: 1 }))).Messages?.length).toBeGreaterThan(0);
  } finally {
    await f.sqs.send(new DeleteQueueCommand({ QueueUrl: output }));
    try { await f.close(); } catch { f.sqs.destroy(); }
  }
}, 90000);

test('erro SQL permanente atribuível à operação válida registra FAILED com inbox e sem efeito financeiro', async () => {
  const f = await inboxFixture(orm); let attempts = 0;
  const dlq = (await f.sqs.send(new CreateQueueCommand({ QueueName: `permanent-${f.ids.next()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  try {
    const submit = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => {
      if (++attempts === 1) await orm.em.fork().execute('select 1 / 0');
    } }), f.clock, f.ids);
    await f.send();
    await new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1, dlqUrl: dlq }).pollOnce();
    const em = orm.em.fork(), tx = await em.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('FAILED'); expect(tx.failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
    expect(tx.result).toMatchObject({ status: 'FAILED', httpStatus: 500, terminal: true });
    expect((await em.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    expect(await em.count(LedgerRecord, { transactionId: tx.id })).toBe(0); expect(await em.count(OutboxRecord, { aggregateId: tx.id })).toBe(0);
    expect((await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).balance).toBe('100.00');
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }))).Messages ?? []).toHaveLength(0);
    const moved = (await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }))).Messages;
    expect(moved).toHaveLength(1); expect(JSON.parse(moved![0]!.Body!)).toEqual(f.envelope);
    expect(moved![0]!.MessageAttributes?.failureClass?.StringValue).toBe('permanent');
    await assertLedger(orm, f.wallet.id);
  } finally { await f.sqs.send(new DeleteQueueCommand({ QueueUrl: dlq })); await f.close(); }
});

test('FAILED confirmado com DLQ indisponível conserva origem e replay tenta envio sem repetir SQL financeira', async () => {
  const f = await inboxFixture(orm); let attempts = 0;
  const dlqName = `missing-${f.ids.next()}.fifo`, dlqUrl = f.queueUrl.replace(/[^/]+$/u, dlqName);
  let created: string | undefined;
  try {
    const submit = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => {
      if (++attempts === 1) await orm.em.fork().execute('select 1 / 0');
    } }), f.clock, f.ids);
    const worker = new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1, dlqUrl });
    await f.send(); let caught = false; try { await worker.pollOnce(); } catch { caught = true; }
    expect(caught).toBe(true);
    const tx = await orm.em.fork().findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('FAILED');
    created = (await f.sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
    await Bun.sleep(1100); expect(await worker.pollOnce()).toBe(1);
    expect(await orm.em.fork().count(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })).toBe(1);
    expect(await orm.em.fork().count(LedgerRecord, { transactionId: tx.id })).toBe(0);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: created, WaitTimeSeconds: 1 }))).Messages).toHaveLength(1);
    expect(await worker.pollOnce()).toBe(0); await assertLedger(orm, f.wallet.id);
  } finally { if (created) await f.sqs.send(new DeleteQueueCommand({ QueueUrl: created })); await f.close(); }
});

test('runtime explícito executa consumer e publisher reais sem ativar consumidor da fila de saída', async () => {
  const f = await inboxFixture(orm);
  const output = (await f.sqs.send(new CreateQueueCommand({ QueueName: `runtime-${f.ids.next()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const dlq = (await f.sqs.send(new CreateQueueCommand({ QueueName: `runtime-dlq-${f.ids.next()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const runtime = createWorkerRuntime({ requestQueueUrl: f.queueUrl, requestDlqUrl: dlq, eventQueueUrl: output, consumerName: f.consumerName, visibilityTimeoutSeconds: 3, heartbeatMs: 200, shutdownGraceMs: 2000 }, orm, f.sqs, f.submit);
  try {
    await f.send(); runtime.start();
    let processed = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await orm.em.fork().findOne(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })) { processed = true; break; }
      await Bun.sleep(25);
    }
    expect(processed).toBe(true);
    await Bun.sleep(300);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: output, WaitTimeSeconds: 1 }))).Messages?.length).toBeGreaterThan(0);
    await assertLedger(orm, f.wallet.id);
  } finally {
    expect(await runtime.stop(2000)).toEqual({ drained: true });
    await f.sqs.send(new DeleteQueueCommand({ QueueUrl: output })); await f.sqs.send(new DeleteQueueCommand({ QueueUrl: dlq })); await f.close();
  }
}, 15000);

test('404 e 409 não fabricam FAILED nem modificam transação terminal original', async () => {
  const f = await inboxFixture(orm);
  try {
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 });
    await f.send(); await worker.pollOnce();
    const original = await orm.em.fork().findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    const conflictMessageId = f.ids.next();
    await f.send({ ...f.envelope, messageId: conflictMessageId, data: { ...f.envelope.data, roundId: 'divergente' } });
    let conflict: unknown; try { await worker.pollOnce(); } catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' });
    const missing = { ...f.envelope, messageId: f.ids.next(), data: { ...f.envelope.data, externalTransactionId: f.ids.next(), idempotencyKey: f.ids.next(), walletId: f.ids.next() } };
    // O primeiro conflito ainda está invisível; outra carteira/grupo evita bloqueio FIFO.
    const missingGroup = (await f.sqs.send(new CreateQueueCommand({ QueueName: `missing-wallet-${f.ids.next()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
    try {
      await f.sqs.send(new SendMessageCommand({ QueueUrl: missingGroup, MessageBody: JSON.stringify(missing), MessageGroupId: missing.data.walletId, MessageDeduplicationId: f.ids.next() }));
      let absent: unknown;
      try { await new SqsConsumer(f.sqs, missingGroup, f.submit, f.consumerName, { waitTimeSeconds: 1 }).pollOnce(); } catch (error) { absent = error; }
      expect(absent).toMatchObject({ code: 'WALLET_NOT_FOUND', httpStatus: 404 });
    } finally { await f.sqs.send(new DeleteQueueCommand({ QueueUrl: missingGroup })); }
    const em = orm.em.fork(), after = await em.findOneOrFail(WagerRecord, { id: original.id });
    expect(after.status).toBe('PROCESSED'); expect(after.result).toEqual(original.result); expect(after.failureCode).toBeNull();
    expect(await em.count(WagerRecord, { idempotencyKey: missing.data.idempotencyKey })).toBe(0);
    expect(await em.count(InboxRecord, { consumerName: f.consumerName })).toBe(1);
    expect(await em.count(LedgerRecord, { transactionId: original.id })).toBe(1); await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
});

test('queda real PostgreSQL em operação recebida não grava FAILED e reprocessa após recuperação', async () => {
  const orm = await createOrm(testEnvironment().databaseUrl);
  const f = await inboxFixture(orm), g = gate(); let held = false, running: Promise<number> | undefined;
  try {
    const submit = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => {
      if (!held) { held = true; g.enter(); await g.hold; }
    } }), f.clock, f.ids);
    const worker = new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1, databaseAvailable: async () => {
      try { await orm.em.fork().execute('select 1'); return true; } catch { return false; }
    } });
    await f.send(); let failure: unknown;
    running = worker.pollOnce().catch(error => { failure = error; return -1; }); await g.entered;
    await withOutage('postgres', async restore => {
      g.release(); expect(await running).toBe(-1); expect(classifyFailure(failure)).toBe('transient');
      for (let i = 0; i < 7; i++) expect(await worker.pollOnce()).toBe(0);
      await restore();
    });
    await Bun.sleep(1100); expect(await worker.pollOnce()).toBe(1);
    const em = orm.em.fork(), tx = await em.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('PROCESSED'); expect(tx.failureCode).toBeNull();
    expect(await em.count(InboxRecord, { consumerName: f.consumerName })).toBe(1); expect(await em.count(LedgerRecord, { transactionId: tx.id })).toBe(1);
    await assertLedger(orm, f.wallet.id);
  } finally {
    g.release(); await running; await f.close();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([orm.close(true).then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 2000); })]);
      expect(closed).toBe(true);
    } finally { clearTimeout(deadline); }
  }
}, 90000);

test('drain dentro do prazo aguarda commit e ack real sem devolver mensagem concluída', async () => {
  const f = await inboxFixture(orm), g = gate(); let running: Promise<number> | undefined;
  try {
    const submit = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => { g.enter(); await g.hold; } }), f.clock, f.ids);
    const worker = new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1, visibilityTimeoutSeconds: 2, heartbeatMs: 200 });
    await f.send(); running = worker.pollOnce(); await g.entered;
    const stopping = worker.stop(1000);
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName })).toBe(0);
    g.release(); expect(await stopping).toEqual({ drained: true }); expect(await running).toBe(1);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }))).Messages ?? []).toHaveLength(0);
    expect((await orm.em.fork().findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    await assertLedger(orm, f.wallet.id);
  } finally { g.release(); await running; await f.close(); }
}, 10000);

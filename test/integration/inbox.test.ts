import { beforeAll, afterAll, test, expect } from 'bun:test';
import { ChangeMessageVisibilityCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { InboxRecord, WalletRecord, WagerRecord, LedgerRecord, OutboxRecord } from '../../src/persistence/records';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import type { IdempotentUnitOfWork } from '../../src/wagering/application/idempotency';
import { DomainError } from '../../src/shared/domain/domain-error';
import { inboxFixture } from '../support/inbox-fixture';
import { testEnvironment } from '../support/environment';
import { assertLedger } from '../support/assert-ledger';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

test('envelope real confirma wallet, transação, ledger, inbox e outbox antes do ack; reinício reaproveita commit', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.send(); let entered!: () => void, release!: () => void;
    const committed = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const crash = new Error('Processo encerrou antes do ack');
    const first = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1, afterCommitBeforeAck: async message => {
      entered(); await hold;
      await f.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: f.queueUrl, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: 0 }));
      throw crash;
    } });
    let caught: unknown;
    const running = first.pollOnce().catch(error => { caught = error; });
    await committed;
    let txId: string;
    try {
      const em = orm.em.fork();
      expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '75.00', version: 2 });
      const tx = await em.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey }); txId = tx.id;
      expect(tx.status).toBe('PROCESSED');
      expect(await em.count(LedgerRecord, { transactionId: tx.id })).toBe(1);
      const inbox = await em.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId });
      expect(inbox.processedAt).not.toBeNull();
      expect(await em.count(OutboxRecord, { aggregateId: tx.id })).toBe(1);
      expect(await em.count(OutboxRecord, { aggregateId: f.wallet.id })).toBe(2);
    } finally { release(); }
    await running; expect(caught).toBe(crash);
    const restarted = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 });
    expect(await restarted.pollOnce()).toBe(1);
    await f.send(); expect(await restarted.pollOnce()).toBe(1);
    await f.send({ ...f.envelope, messageId: f.ids.next() }); expect(await restarted.pollOnce()).toBe(1);
    const em = orm.em.fork();
    expect(await em.count(InboxRecord, { consumerName: f.consumerName })).toBe(2);
    expect(await em.count(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })).toBe(1);
    expect(await em.count(LedgerRecord, { transactionId: txId! })).toBe(1);
    expect(await em.count(OutboxRecord, { aggregateId: txId! })).toBe(1);
    expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '75.00', version: 2 });
    expect(await restarted.pollOnce()).toBe(0); await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
}, 15000);

test('mesma identidade de inbox com conteúdo divergente propaga conflito e não recebe ack', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.sqs.send(new SetQueueAttributesCommand({ QueueUrl: f.queueUrl, Attributes: { VisibilityTimeout: '1' } }));
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 });
    await f.send(); await worker.pollOnce();
    await f.send({ ...f.envelope, data: { ...f.envelope.data, money: { amount: '30.00', currency: 'BRL' } } });
    let caught: unknown; try { await worker.pollOnce(); } catch (error) { caught = error; }
    expect((caught as DomainError).code).toBe('INBOX_PAYLOAD_CONFLICT');
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName })).toBe(1);
    expect(await orm.em.fork().findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '75.00', version: 2 });
    await Bun.sleep(1100);
    let redelivery: unknown; try { await worker.pollOnce(); } catch (error) { redelivery = error; }
    expect((redelivery as DomainError).code).toBe('INBOX_PAYLOAD_CONFLICT');
    await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
});

test('lock advisory de inbox respeita timeout antes da reserva e não deixa linhas parciais', async () => {
  const f = await inboxFixture(orm);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const locked = new Promise<void>(resolve => { entered = resolve; });
  const inbox = { consumerName: f.consumerName, messageId: f.envelope.messageId, payloadHash: 'a'.repeat(64), receivedAt: new Date() };
  const blocker = orm.em.fork().transactional(async em => {
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [JSON.stringify([inbox.consumerName, inbox.messageId])]);
    entered(); await hold;
  });
  try {
    await locked;
    const { idempotencyKey, ...payload } = f.envelope.data;
    const timed = new SubmitWager(new PostgresUnitOfWork(orm, { lockTimeoutMs: 40 }), f.clock, f.ids, async () => {});
    let caught: unknown;
    try { await timed.execute(payload, { idempotencyKey, correlationId: f.ids.next(), inbox }); } catch (error) { caught = error; }
    expect((caught as { code: string }).code).toBe('PROCESSING_UNAVAILABLE');
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName })).toBe(0);
    expect(await orm.em.fork().count(WagerRecord, { idempotencyKey })).toBe(0);
  } finally { release(); await blocker; await f.close(); }
}, 10000);

test('identidade composta permite outro consumidor e concorrência de novas mensagens sem duplicar efeitos', async () => {
  const f = await inboxFixture(orm);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  try {
    let entered!: () => void, reservations = 0;
    const reserved = new Promise<void>(resolve => { entered = resolve; });
    const gated = new SubmitWager(new PostgresUnitOfWork(orm, { afterInboxReserved: async () => {
      if (++reservations === 1) { entered(); await hold; }
    } }), f.clock, f.ids);
    const inbox = { consumerName: f.consumerName, messageId: f.envelope.messageId, payloadHash: 'a'.repeat(64), receivedAt: new Date() };
    const { idempotencyKey, ...payload } = f.envelope.data;
    const run = (messageId: string, consumerName = f.consumerName) => gated.execute(payload, { idempotencyKey, correlationId: messageId, inbox: { ...inbox, consumerName, messageId } });
    const first = run(inbox.messageId); await reserved;
    const competing = [run(inbox.messageId), run(f.ids.next()), run(inbox.messageId, `${f.consumerName}-other`)];
    let observed = false;
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const rows = await orm.em.fork().execute<{ blocked: boolean }[]>(`select exists (
          select 1 from pg_stat_activity where usename = current_user and pid <> pg_backend_pid()
          and query ilike '%pg_advisory_xact_lock%' and cardinality(pg_blocking_pids(pid)) > 0
        ) as blocked`);
        if (rows[0]?.blocked) { observed = true; break; }
        await Bun.sleep(10);
      }
    } finally { release(); }
    const responses = await Promise.all([first, ...competing]);
    expect(observed).toBe(true);
    expect(responses.filter(r => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map(r => r.transactionId)).size).toBe(1);
    expect(await orm.em.fork().count(InboxRecord, { consumerName: { $in: [f.consumerName, `${f.consumerName}-other`] } })).toBe(3);
    expect(await orm.em.fork().findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '75.00', version: 2 });
    expect(await orm.em.fork().count(LedgerRecord, { transactionId: responses[0]!.transactionId })).toBe(1);
    await assertLedger(orm, f.wallet.id);
  } finally { release(); await f.close(); }
});

test('PENDING_REFERENCE persistida recebe ack sem aplicar efeitos financeiros', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.send({ ...f.envelope, data: { ...f.envelope.data, kind: 'REFUND', referenceExternalTransactionId: f.ids.next() } });
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 });
    expect(await worker.pollOnce()).toBe(1);
    const em = orm.em.fork(), tx = await em.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('PENDING_REFERENCE'); expect(tx.referenceDeadline).not.toBeNull();
    expect(await em.count(LedgerRecord, { transactionId: tx.id })).toBe(0);
    expect(await em.count(OutboxRecord, { aggregateId: tx.id, eventType: 'WagerTransactionPendingReference' })).toBe(1);
    expect((await em.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    expect(await worker.pollOnce()).toBe(0); await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
});

test('envelope ISO com offset explícito chega por SQS real e confirma inbox junto dos efeitos', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.send({ ...f.envelope, occurredAt: '2026-10-25T09:00:00.123456-03:00' });
    expect(await new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 }).pollOnce()).toBe(1);
    const em = orm.em.fork(), tx = await em.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('PROCESSED');
    expect((await em.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    expect(await em.count(LedgerRecord, { transactionId: tx.id })).toBe(1);
    await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
});

test('nova mensagem com conflito de transação desfaz a própria reserva de inbox', async () => {
  const f = await inboxFixture(orm);
  try {
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 });
    await f.send(); await worker.pollOnce(); const messageId = f.ids.next();
    await f.send({ ...f.envelope, messageId, data: { ...f.envelope.data, roundId: 'other' } });
    let caught: unknown; try { await worker.pollOnce(); } catch (error) { caught = error; }
    expect((caught as DomainError).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName, messageId })).toBe(0);
    await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
});

test('erro transitório após efeitos SQL refaz inbox imutável e confirma uma única movimentação', async () => {
  const f = await inboxFixture(orm);
  try {
    let attempts = 0;
    const real = new PostgresUnitOfWork(orm);
    const transient = Object.assign(new Error('serialization failure'), { code: '40001' });
    const faulty: IdempotentUnitOfWork = { runIdempotent: (tx, work, options) => real.runIdempotent(tx, async session => {
      const result = await work(session);
      if (++attempts === 1) throw transient;
      return result;
    }, options) };
    const submit = new SubmitWager(faulty, f.clock, f.ids, async () => {});
    await f.send(); await new SqsConsumer(f.sqs, f.queueUrl, submit, f.consumerName, { waitTimeSeconds: 1 }).pollOnce();
    expect(attempts).toBe(2);
    const em = orm.em.fork();
    expect(await em.count(InboxRecord, { consumerName: f.consumerName })).toBe(1);
    expect((await em.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    expect(await em.findOneOrFail(WalletRecord, { id: f.wallet.id })).toMatchObject({ balance: '75.00', version: 2 });
    await assertLedger(orm, f.wallet.id);
  } finally { await f.close(); }
});

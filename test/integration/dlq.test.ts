import { beforeAll, afterAll, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createOrm } from '../../src/persistence/orm';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { InboxRecord, LedgerRecord, WagerRecord } from '../../src/persistence/records';
import { inboxFixture } from '../support/inbox-fixture';
import { testEnvironment } from '../support/environment';
let orm: Awaited<ReturnType<typeof createOrm>>;
beforeAll(async () => {
  const env = testEnvironment(), migration = await createOrm(env.migrationDatabaseUrl);
  try { await migration.migrator.up(); } finally { await migration.close(true); }
  orm = await createOrm(env.databaseUrl);
});
afterAll(async () => { await orm?.close(true); });

test('malformada preserva corpo e identidade na DLQ real antes de remover origem; duplicata é tolerada', async () => {
  const f = await inboxFixture(orm);
  const dlq = (await f.sqs.send(new CreateQueueCommand({ QueueName: `dlq-${f.ids.next()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  try {
    const sent = await f.sqs.send(new SendMessageCommand({ QueueUrl: f.queueUrl, MessageBody: '{', MessageGroupId: 'invalid', MessageDeduplicationId: f.ids.next() }));
    let sends = 0;
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1, visibilityTimeoutSeconds: 1, heartbeatMs: 200, dlqUrl: dlq,
      afterDlqSendBeforeAck: async () => { if (++sends === 1) throw new Error('Crash após envio durável, antes do ack'); } });
    let crashed = false; try { await worker.pollOnce(); } catch { crashed = true; }
    expect(crashed).toBe(true); await Bun.sleep(1100); expect(await worker.pollOnce()).toBe(1);
    const moved = (await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] }))).Messages!;
    expect(moved).toHaveLength(1); expect(moved[0]!.Body).toBe('{');
    expect(moved[0]!.MessageAttributes?.sourceMessageId?.StringValue).toBe(sent.MessageId!);
    expect(moved[0]!.Attributes?.MessageDeduplicationId).toBe(sent.MessageId!);
    // Duplicata operacional explícita além da dedupe FIFO: mesma identidade de origem.
    await f.sqs.send(new SendMessageCommand({ QueueUrl: dlq, MessageBody: '{', MessageGroupId: 'invalid', MessageDeduplicationId: f.ids.next(),
      MessageAttributes: moved[0]!.MessageAttributes }));
    await f.sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: moved[0]!.ReceiptHandle! }));
    const duplicate = (await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }))).Messages!;
    expect(duplicate).toHaveLength(1); expect(duplicate[0]!.Body).toBe('{');
    expect(duplicate[0]!.MessageAttributes?.sourceMessageId?.StringValue).toBe(sent.MessageId!);
    expect(await worker.pollOnce()).toBe(0);
    expect(await orm.em.fork().count(InboxRecord, { consumerName: f.consumerName })).toBe(0);
    expect(await orm.em.fork().count(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })).toBe(0);
  } finally { await f.sqs.send(new DeleteQueueCommand({ QueueUrl: dlq })); await f.close(); }
});

test('falha real de envio à DLQ conserva mensagem na origem sem criar FAILED', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.sqs.send(new SetQueueAttributesCommand({ QueueUrl: f.queueUrl, Attributes: { VisibilityTimeout: '1' } }));
    await f.send({ invalid: true });
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1, dlqUrl: f.queueUrl.replace(/[^/]+$/u, 'missing-dlq.fifo') });
    let failed = false; try { await worker.pollOnce(); } catch { failed = true; }
    expect(failed).toBe(true);
    await Bun.sleep(1100);
    const remaining = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }));
    expect(remaining.Messages).toHaveLength(1);
    expect(await orm.em.fork().count(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey })).toBe(0);
  } finally { await f.close(); }
});

test('rejeição de negócio confirmada recebe ack com inbox e sem ledger', async () => {
  const f = await inboxFixture(orm);
  try {
    await f.send({ ...f.envelope, data: { ...f.envelope.data, money: { amount: '999.00', currency: 'BRL' } } });
    const worker = new SqsConsumer(f.sqs, f.queueUrl, f.submit, f.consumerName, { waitTimeSeconds: 1 });
    await worker.pollOnce();
    const em = orm.em.fork(), tx = await em.findOneOrFail(WagerRecord, { idempotencyKey: f.envelope.data.idempotencyKey });
    expect(tx.status).toBe('REJECTED'); expect(await em.count(LedgerRecord, { transactionId: tx.id })).toBe(0);
    expect((await em.findOneOrFail(InboxRecord, { consumerName: f.consumerName, messageId: f.envelope.messageId })).processedAt).not.toBeNull();
    expect(await worker.pollOnce()).toBe(0);
  } finally { await f.close(); }
});

test('redrive configurado move à DLQ somente após cinco recebimentos', async () => {
  const f = await inboxFixture(orm);
  const dlq = (await f.sqs.send(new CreateQueueCommand({ QueueName: `redrive-${f.ids.next()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  try {
    const arn = (await f.sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
    await f.sqs.send(new SetQueueAttributesCommand({ QueueUrl: f.queueUrl, Attributes: { VisibilityTimeout: '0', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }) } }));
    await f.send();
    for (let i = 1; i <= 5; i++) {
      const got = await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
      expect(got.Messages?.[0]?.Attributes?.ApproximateReceiveCount).toBe(String(i));
    }
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: f.queueUrl, WaitTimeSeconds: 1 }))).Messages ?? []).toHaveLength(0);
    expect((await f.sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 1 }))).Messages).toHaveLength(1);
  } finally { await f.sqs.send(new DeleteQueueCommand({ QueueUrl: dlq })); await f.close(); }
});

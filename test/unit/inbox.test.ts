import { expect, test, spyOn } from 'bun:test';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import { SqsConsumer, wagerEnvelope, envelopeHash } from '../../src/workers/sqs-consumer';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
const context = { consumerName: 'wagering', messageId: 'msg-1', payloadHash: 'a'.repeat(64), receivedAt: new Date() };
test('inbox aceita reentrega do mesmo conteúdo', () => {
  expect(() => InboxMessage.receive(context).assertSamePayload(context.payloadHash)).not.toThrow();
});
test('inbox rejeita conteúdo divergente para identidade composta', () => {
  expect(() => InboxMessage.receive(context).assertSamePayload('b'.repeat(64))).toThrow();
});
test('inbox isola consumidores e protege datas sem mutação entre tentativas', () => {
  const first = InboxMessage.receive(context), second = InboxMessage.receive({ ...context, consumerName: 'other' });
  expect(first.consumerName).not.toBe(second.consumerName);
  const completed = first.complete(new Date(context.receivedAt.getTime() + 1));
  expect(first.processedAt).toBeNull();
  expect(completed.processedAt).not.toBeNull();
  completed.processedAt!.setFullYear(2000); first.receivedAt.setFullYear(2000);
  expect(first.receivedAt).toEqual(context.receivedAt);
  expect(completed.processedAt!.getFullYear()).toBe(context.receivedAt.getFullYear());
  expect(() => first.complete(new Date(0))).toThrow();
});
test('inbox imutável protege runtime e conclusão repetida mantém instante original', () => {
  const first = InboxMessage.receive(context);
  expect(Object.isFrozen(first)).toBe(true);
  const at = new Date(context.receivedAt.getTime() + 1), completed = first.complete(at);
  expect(Object.isFrozen(completed)).toBe(true);
  expect(completed.complete(new Date(at.getTime() + 1000)).processedAt).toEqual(at);
});
function envelope() { return { messageId: 'msg-domain', type: 'WagerTransactionRequested', occurredAt: '2026-10-25T12:00:00.000Z',
  data: { providerId: 'aurora', externalTransactionId: 'external', idempotencyKey: 'idem', playerId: crypto.randomUUID(), walletId: crypto.randomUUID(),
    roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } } }; }
test('envelope aceita ISO com offset explícito preservando instante no hash de transporte', () => {
  const input = { ...envelope(), occurredAt: '2026-10-25T09:00:00.123456-03:00' };
  expect(wagerEnvelope(input).occurredAt).toBe(input.occurredAt);
});
test('hash canônico ignora ordem e inclui horário e chave do envelope', () => {
  const input = envelope(); const canonical = wagerEnvelope(input);
  expect(envelopeHash(wagerEnvelope({ data: input.data, occurredAt: input.occurredAt, type: input.type, messageId: input.messageId }))).toBe(envelopeHash(canonical));
  expect(envelopeHash(wagerEnvelope({ ...input, occurredAt: '2026-10-25T13:00:00Z' }))).not.toBe(envelopeHash(canonical));
  expect(envelopeHash(wagerEnvelope({ ...input, data: { ...input.data, idempotencyKey: 'other' } }))).not.toBe(envelopeHash(canonical));
});
test.each([
  (e: ReturnType<typeof envelope>) => ({ ...e, extra: true }),
  (e: ReturnType<typeof envelope>) => ({ ...e, type: 'Other' }),
  (e: ReturnType<typeof envelope>) => ({ ...e, messageId: '' }),
  (e: ReturnType<typeof envelope>) => ({ ...e, occurredAt: '2026-02-30T12:00:00Z' }),
  (e: ReturnType<typeof envelope>) => ({ ...e, occurredAt: '2026-10-25T09:00:00-25:00' }),
  (e: ReturnType<typeof envelope>) => ({ ...e, occurredAt: '2026-10-25T24:00:00Z' }),
  (e: ReturnType<typeof envelope>) => ({ ...e, data: { ...e.data, extra: true } }),
  (e: ReturnType<typeof envelope>) => ({ ...e, data: { ...e.data, kind: 'OPENING' } }),
  (e: ReturnType<typeof envelope>) => ({ ...e, data: { ...e.data, providerId: ' ' } }),
  (e: ReturnType<typeof envelope>) => ({ ...e, data: { ...e.data, idempotencyKey: '' } }),
  (e: ReturnType<typeof envelope>) => ({ ...e, data: { ...e.data, money: { amount: '10.00', currency: 'BRL', extra: 1 } } }),
])('envelope rejeita contrato inválido', change => { expect(() => wagerEnvelope(change(envelope()))).toThrow(); });
test.each([false, true])('consumidor confirma somente após retorno do commit; falha=%s', async failed => {
  const sqs = new SQSClient({ region: 'us-east-1' }), input = envelope(); const commands: unknown[] = [];
  const send = spyOn(sqs, 'send').mockImplementation((async (command: unknown) => {
    commands.push(command);
    return command instanceof ReceiveMessageCommand ? { Messages: [{ Body: JSON.stringify(input), MessageId: 'aws-id', ReceiptHandle: 'receipt' }] } : {};
  }) as never);
  const failure = new Error('commit falhou'); let submitted = false, beforeAck = false;
  const consumer = new SqsConsumer(sqs, 'http://local/queue', { execute: async (_payload, ctx) => {
    expect(commands.some(c => c instanceof DeleteMessageCommand)).toBe(false);
    expect(ctx.inbox).toMatchObject({ consumerName: 'consumer', messageId: input.messageId }); submitted = true;
    if (failed) throw failure;
    return { transactionId: 'id', status: 'PROCESSED', terminal: true, httpStatus: 200, idempotentReplay: false };
  } }, 'consumer', { afterCommitBeforeAck: async () => { beforeAck = true; expect(commands).toHaveLength(1); } });
  let caught: unknown; try { await consumer.pollOnce(); } catch (error) { caught = error; }
  expect(submitted).toBe(true); expect(beforeAck).toBe(!failed);
  expect(caught).toBe(failed ? failure : undefined);
  expect(commands.filter(c => c instanceof DeleteMessageCommand)).toHaveLength(failed ? 0 : 1);
  expect((commands[0] as ReceiveMessageCommand).input).toMatchObject({ WaitTimeSeconds: 20, MaxNumberOfMessages: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'] });
  if (!failed) expect((commands[1] as DeleteMessageCommand).input.ReceiptHandle).toBe('receipt');
  send.mockRestore(); sqs.destroy();
});

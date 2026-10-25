import { test, expect } from 'bun:test';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { OutboxPublisher } from '../../src/workers/outbox-publisher';
import type { OutboxStore } from '../../src/messaging/application/outbox-store';
import type { SQSClient } from '@aws-sdk/client-sqs';
const now = new Date('2026-10-25T12:00:00Z');
const input = () => ({ id: crypto.randomUUID(), aggregateId: crypto.randomUUID(), eventType: 'WalletOpened', payload: { nested: { value: '10.00' } }, occurredAt: new Date(now) });
test('evento mantém identidade, cópias defensivas e retry exponencial limitado sem descarte', () => {
  const source = input(), event = OutboxMessage.create(source); source.payload.nested.value = '99.00'; source.occurredAt.setFullYear(2000);
  expect(event.snapshot().payload).toEqual({ nested: { value: '10.00' } });
  const copy = event.snapshot(); copy.occurredAt.setFullYear(2000);
  expect(event.snapshot().occurredAt).toEqual(now); expect(event.isDue(now)).toBe(true);
  let retry = event.retry(now);
  expect(retry.snapshot()).toMatchObject({ id: event.snapshot().id, attempts: 1, nextAttemptAt: new Date(now.getTime() + 1000), leaseOwner: null, leaseUntil: null });
  expect(retry.isDue(now)).toBe(false); expect(retry.isDue(new Date(now.getTime() + 1000))).toBe(true);
  retry = retry.retry(now); expect(retry.snapshot().nextAttemptAt).toEqual(new Date(now.getTime() + 2000));
  for (let i = 0; i < 100; i++) retry = retry.retry(now);
  expect(retry.snapshot().nextAttemptAt).toEqual(new Date(now.getTime() + 300000));
  const published = retry.published(now); expect(published.isDue(new Date('2099-01-01'))).toBe(false);
  expect(published.snapshot()).toMatchObject({ publishedAt: now, leaseOwner: null, leaseUntil: null, nextAttemptAt: null });
  expect(() => published.retry(now)).toThrow();
});
test('rehidratação rejeita lease incoerente, tentativas inválidas e data inválida', () => {
  const state = { ...input(), attempts: 0, nextAttemptAt: null, publishedAt: null, leaseOwner: null, leaseUntil: null };
  expect(() => OutboxMessage.rehydrate({ ...state, leaseOwner: crypto.randomUUID() })).toThrow();
  expect(() => OutboxMessage.rehydrate({ ...state, attempts: -1 })).toThrow();
  expect(() => OutboxMessage.rehydrate({ ...state, occurredAt: new Date('invalid') })).toThrow();
});
test('outbox é imutável em runtime e respeita lease ativo, vencido e estado publicado', () => {
  const message = OutboxMessage.create(input()); expect(Object.isFrozen(message)).toBe(true);
  expect(Object.getOwnPropertyNames(message)).not.toContain('state');
  const leased = OutboxMessage.rehydrate({ ...message.snapshot(), leaseOwner: crypto.randomUUID(), leaseUntil: new Date(now.getTime() + 1000) });
  expect(leased.isDue(now)).toBe(false); expect(leased.isDue(new Date(now.getTime() + 1000))).toBe(true);
  expect(() => OutboxMessage.rehydrate({ ...leased.snapshot(), publishedAt: now })).toThrow();
});
test('lote bounded inicia o segundo envio enquanto o primeiro aguarda rede', async () => {
  const messages = [OutboxMessage.create(input()), OutboxMessage.create(input())];
  let release!: () => void, firstStarted!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { firstStarted = resolve; });
  let sends = 0, marks = 0; const signals: (AbortSignal | undefined)[] = [];
  const store: OutboxStore = { claim: async () => messages, markPublished: async () => { marks++; return true; }, fail: async () => true };
  const sqs = { send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
    signals.push(options?.abortSignal);
    if (++sends === 1) { firstStarted(); await hold; }
    return {};
  } } as unknown as Pick<SQSClient, 'send'>;
  const publisher = new OutboxPublisher(store, sqs, 'queue', { next: () => crypto.randomUUID() }, undefined, { batchSize: 2 });
  const running = publisher.pollOnce();
  try { await started; await Promise.resolve(); await Promise.resolve(); expect(sends).toBe(2); expect(signals.every(Boolean)).toBe(true); }
  finally { release(); await running; }
  expect(marks).toBe(2);
});
test('falha de um item só propaga depois de todos os envios do lote assentarem', async () => {
  const messages = [OutboxMessage.create(input()), OutboxMessage.create(input())];
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  let sends = 0, settled = false;
  const store: OutboxStore = { claim: async () => messages, markPublished: async () => true, fail: async () => true };
  const sqs = { send: async () => { if (++sends === 2) await hold; return {}; } } as unknown as Pick<SQSClient, 'send'>;
  const failure = new Error('SQL indisponível');
  const publisher = new OutboxPublisher(store, sqs, 'queue', { next: () => crypto.randomUUID() }, undefined,
    { afterSendBeforePublished: async message => { if (message.snapshot().id === messages[0]!.snapshot().id) throw failure; } });
  let caught: unknown;
  const running = publisher.pollOnce().catch(error => { caught = error; }).finally(() => { settled = true; });
  try { for (let i = 0; i < 10; i++) await Promise.resolve(); expect(settled).toBe(false); expect(sends).toBe(2); }
  finally { release(); await running; }
  expect(caught).toBe(failure);
});
test('publisher aborta rede lenta dentro do lease e valida limites de lote e prazo', async () => {
  const message = OutboxMessage.create(input()); let failed = 0, aborted = false;
  const store: OutboxStore = { claim: async () => [message], markPublished: async () => { throw new Error('Não pode confirmar envio abortado'); }, fail: async () => { failed++; return true; } };
  const sqs = { send: async (_command: unknown, options: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
    options.abortSignal.addEventListener('abort', () => { aborted = true; reject(options.abortSignal.reason); }, { once: true });
  }) } as unknown as Pick<SQSClient, 'send'>;
  const make = (options: { batchSize?: number; leaseMs?: number; sendTimeoutMs?: number }) => new OutboxPublisher(store, sqs, 'queue', { next: () => crypto.randomUUID() }, undefined, options);
  expect(() => make({ batchSize: 0 })).toThrow(); expect(() => make({ batchSize: 51 })).toThrow();
  expect(() => make({ leaseMs: 99 })).toThrow(); expect(() => make({ leaseMs: 300001 })).toThrow();
  expect(() => make({ leaseMs: 100, sendTimeoutMs: 51 })).toThrow();
  expect(await make({ leaseMs: 100, sendTimeoutMs: 20 }).pollOnce()).toBe(0); expect(aborted).toBe(true); expect(failed).toBe(1);
});
test('publisher usa eventId estável, grupo agregado e só confirma depois do envio', async () => {
  const message = OutboxMessage.create(input()), calls: string[] = [], bodies: unknown[] = [];
  const store: OutboxStore = { claim: async options => { expect(options.limit).toBe(2); calls.push('claim'); return [message]; },
    markPublished: async () => { calls.push('published'); return true; }, fail: async () => { calls.push('fail'); return true; } };
  const sqs = { send: async (command: { input: unknown }) => { calls.push('send'); bodies.push(command.input); return {}; } } as unknown as Pick<SQSClient, 'send'>;
  const publisher = new OutboxPublisher(store, sqs, 'integration.fifo', { next: () => crypto.randomUUID() }, { now: () => now }, { batchSize: 2 });
  expect(await publisher.pollOnce()).toBe(1); expect(calls).toEqual(['claim', 'send', 'published']);
  expect(bodies[0]).toMatchObject({ QueueUrl: 'integration.fifo', MessageGroupId: message.snapshot().aggregateId, MessageDeduplicationId: message.snapshot().id });
  expect(JSON.parse((bodies[0] as { MessageBody: string }).MessageBody)).toEqual(message.snapshot().payload);
});
test('falha de rede agenda retry; falha depois do envio mantém lease recuperável', async () => {
  const message = OutboxMessage.create(input()); let failed = 0, published = 0;
  const store: OutboxStore = { claim: async () => [message], markPublished: async () => { published++; return true; }, fail: async () => { failed++; return true; } };
  const broken = { send: async () => { throw new Error('SQS indisponível'); } } as unknown as Pick<SQSClient, 'send'>;
  expect(await new OutboxPublisher(store, broken, 'queue', { next: () => crypto.randomUUID() }).pollOnce()).toBe(0);
  expect(failed).toBe(1); expect(published).toBe(0);
  const ok = { send: async () => ({}) } as unknown as Pick<SQSClient, 'send'>;
  let error: unknown;
  try { await new OutboxPublisher(store, ok, 'queue', { next: () => crypto.randomUUID() }, undefined, { afterSendBeforePublished: async () => { throw new Error('crash'); } }).pollOnce(); } catch (caught) { error = caught; }
  expect((error as Error).message).toBe('crash'); expect(failed).toBe(1); expect(published).toBe(0);
});

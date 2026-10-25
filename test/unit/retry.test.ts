import { expect, test } from 'bun:test';
import { classifyFailure, retryDelaySeconds, WorkerLifecycle } from '../../src/workers/worker-lifecycle';
import { ApplicationError } from '../../src/shared/application/application-error';
import { isTransientFailure } from '../../src/shared/application/transient-failure';
import { releaseAfterDisconnectedRollback } from '../../src/persistence/recovering-postgres-driver';
import { readWorkerConfiguration } from '../../src/workers/worker-runtime';
import { SqsConsumer } from '../../src/workers/sqs-consumer';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

test('classifica negócio, transitório e permanente sem transformar falha desconhecida em rejeição', () => {
  expect(classifyFailure(new ApplicationError('WALLET_NOT_FOUND', 'Ausente', 404))).toBe('business');
  expect(classifyFailure(new ApplicationError('PROCESSING_UNAVAILABLE', 'Indisponível', 503))).toBe('transient');
  for (const code of ['40001', 'ECONNREFUSED', '57P01']) expect(classifyFailure({ code })).toBe('transient');
  expect(classifyFailure({ code: '23514' })).toBe('permanent');
  expect(classifyFailure(new Error('Desconhecido'))).toBe('transient');
});

test('backoff crescente tem teto sem overflow após muitas entregas', () => {
  expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([1, 2, 4, 8]);
  expect(retryDelaySeconds(100000)).toBe(300);
  expect(retryDelaySeconds(0)).toBe(1);
});

function client() {
  const commands: unknown[] = [];
  const sqs = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: '{', ReceiptHandle: 'receipt', MessageId: 'stable', Attributes: { ApproximateReceiveCount: '1' } }] };
    return { MessageId: 'durable' };
  } } as unknown as SQSClient;
  return { sqs, commands };
}

test('malformada só recebe ack depois do envio durável para DLQ', async () => {
  const f = client();
  const worker = new SqsConsumer(f.sqs, 'http://queue', { execute: async () => { throw new Error('Nunca executar'); } }, 'consumer', { dlqUrl: 'http://dlq' });
  await worker.pollOnce();
  expect(f.commands.map(c => (c as object).constructor.name)).toEqual(['ReceiveMessageCommand', 'SendMessageCommand', 'DeleteMessageCommand']);
  expect((f.commands[1] as SendMessageCommand).input.MessageBody).toBe('{');
  expect((f.commands[1] as SendMessageCommand).input.MessageDeduplicationId).toBe('stable');
});

test('preflight de banco impede recebimentos que esgotariam artificialmente o redrive', async () => {
  const f = client(); let probes = 0;
  const worker = new SqsConsumer(f.sqs, 'http://queue', { execute: async () => { throw new Error('Nunca executar'); } }, 'consumer', { databaseAvailable: async () => { probes++; return false; } });
  for (let i = 0; i < 7; i++) expect(await worker.pollOnce()).toBe(0);
  expect(probes).toBe(1);
  expect(f.commands).toHaveLength(0);
});

test('supervisor drena operações já iniciadas sem começar novo poll', async () => {
  let polls = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const lifecycle = new WorkerLifecycle([{ pollOnce: async () => { polls++; await hold; return 1; } }]);
  lifecycle.start(); const stopped = lifecycle.stop(100); release();
  expect(await stopped).toEqual({ drained: true }); expect(polls).toBe(1);
});

test('supervisor informa prazo esgotado sem afirmar conclusão da operação', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const lifecycle = new WorkerLifecycle([{ pollOnce: async () => { await hold; return 1; } }]);
  lifecycle.start();
  try { expect(await lifecycle.stop(5)).toEqual({ drained: false }); }
  finally { release(); }
});

test('stop cancela long poll via AbortSignal sem iniciar novas buscas', async () => {
  let polls = 0, aborted = false;
  const sqs = { send: (_command: unknown, options: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
    polls++; options.abortSignal.addEventListener('abort', () => { aborted = true; reject(new Error('Abortado')); });
  }) } as unknown as SQSClient;
  const worker = new SqsConsumer(sqs, 'http://queue', { execute: async () => { throw new Error('Nunca executar'); } });
  const pending = worker.pollOnce(); expect(await worker.stop(100)).toEqual({ drained: true });
  expect(await pending).toBe(0); expect(await worker.pollOnce()).toBe(0); expect(polls).toBe(1); expect(aborted).toBe(true);
});

test('runtime explícito exige três filas FIFO distintas e valida prazos de heartbeat e drain', () => {
  const env = { REQUEST_QUEUE_URL: 'http://localhost:4566/000000000000/requests.fifo', REQUEST_DLQ_URL: 'http://localhost:4566/000000000000/dlq.fifo', EVENT_QUEUE_URL: 'http://localhost:4566/000000000000/events.fifo' };
  expect(() => readWorkerConfiguration({})).toThrow();
  expect(readWorkerConfiguration(env)).toMatchObject({ requestQueueUrl: env.REQUEST_QUEUE_URL, heartbeatMs: 10000, shutdownGraceMs: 25000 });
  expect(() => readWorkerConfiguration({ ...env, REQUEST_DLQ_URL: env.REQUEST_QUEUE_URL })).toThrow();
  expect(() => readWorkerConfiguration({ ...env, WORKER_HEARTBEAT_MS: '15000' })).toThrow();
  expect(() => readWorkerConfiguration({ ...env, WORKER_SHUTDOWN_GRACE_MS: '-1' })).toThrow();
});

test('URL inválida do runtime gera erro sanitizado sem input ou credenciais', () => {
  const secret = 'senha-nao-expor', input = `http://usuario:${secret}@[invalido`;
  let caught: unknown; try { readWorkerConfiguration({ REQUEST_QUEUE_URL: input }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe('REQUEST_QUEUE_URL inválida');
  expect(Object.getOwnPropertyNames(caught).join(',')).not.toContain('input');
  expect(String(caught)).not.toContain(secret);
});

test('permanente confirma FAILED antes da DLQ; falha de envio preserva origem e replay FAILED tenta DLQ novamente', async () => {
  const envelope = { messageId: 'message', type: 'WagerTransactionRequested', occurredAt: '2026-10-25T12:00:00Z', data: {
    providerId: 'aurora', externalTransactionId: 'external', idempotencyKey: 'key', walletId: '00000000-0000-4000-8000-000000000001',
    playerId: '00000000-0000-4000-8000-000000000002', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  } };
  const calls: string[] = []; let failed = false, unavailable = true;
  const response = { transactionId: 'tx', status: 'FAILED' as const, httpStatus: 500, terminal: true, idempotentReplay: false };
  const sqs = { send: async (command: unknown) => {
    if (command instanceof ReceiveMessageCommand) return { Messages: [{ MessageId: 'stable', ReceiptHandle: 'receipt', Body: JSON.stringify(envelope) }] };
    if (command instanceof SendMessageCommand) { calls.push('dlq'); if (unavailable) throw new Error('SQS indisponível'); return { MessageId: 'accepted' }; }
    if (command instanceof DeleteMessageCommand) calls.push('ack');
    return {};
  } } as unknown as SQSClient;
  const worker = new SqsConsumer(sqs, 'http://queue', {
    execute: async () => { if (failed) { calls.push('replay'); return { ...response, idempotentReplay: true }; } throw { code: '23514' }; },
    recordPermanentFailure: async () => { calls.push('commit-failed'); failed = true; return response; },
  }, 'consumer', { dlqUrl: 'http://dlq' });
  let caught = false; try { await worker.pollOnce(); } catch { caught = true; }
  expect(caught).toBe(true); expect(calls).toEqual(['commit-failed', 'dlq']);
  unavailable = false; await worker.pollOnce();
  expect(calls).toEqual(['commit-failed', 'dlq', 'replay', 'dlq', 'ack']);
});

test('prazo de envio à DLQ aborta RPC travado e preserva origem sem ack', async () => {
  const commands: unknown[] = []; let aborted = false;
  const sqs = { send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
    commands.push(command);
    if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: '{', MessageId: 'stable', ReceiptHandle: 'receipt' }] };
    if (command instanceof SendMessageCommand) return new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener('abort', () => { aborted = true; reject(new Error('Prazo excedido')); });
      // O scaffold sem prazo falha comportamentalmente sem deixar o teste travado.
      setTimeout(() => reject(new Error('Não recebeu abort')), 100);
    });
    return {};
  } } as unknown as SQSClient;
  const worker = new SqsConsumer(sqs, 'http://queue', { execute: async () => { throw new Error('Nunca executar'); } }, 'consumer', { dlqUrl: 'http://dlq', sqsRequestTimeoutMs: 5 });
  let caught = false; try { await worker.pollOnce(); } catch { caught = true; }
  expect(caught).toBe(true); expect(aborted).toBe(true); expect(commands.some(c => c instanceof DeleteMessageCommand)).toBe(false);
});

test('cliente PostgreSQL sem code reconhece somente a mensagem exata de conexão morta', () => {
  const disconnected = new Error('Client has encountered a connection error and is not queryable');
  disconnected.name = 'DriverException';
  expect(isTransientFailure(disconnected)).toBe(true);
  expect(isTransientFailure(new Error('Outra falha técnica'))).toBe(false);
  expect(isTransientFailure(new Error('Client has encountered another query error'))).toBe(false);
  expect(isTransientFailure(new Error('DriverException de SQL permanente', { cause: Object.assign(new Error('Check'), { code: '23514' }) }))).toBe(false);
});

test('rollback em conexão já morta permite release; erro SQL normal e falha desconhecida continuam propagados', async () => {
  let released = false;
  try { await releaseAfterDisconnectedRollback(async () => { throw new Error('Client has encountered a connection error and is not queryable'); }); released = true; } catch {}
  expect(released).toBe(true);
  for (const code of ['57014', '40001', '23514', '08007', 'ETIMEDOUT', 'unknown']) {
    const original = Object.assign(new Error('Falha de rollback'), { code }); let caught: unknown;
    try { await releaseAfterDisconnectedRollback(async () => { throw original; }); } catch (error) { caught = error; }
    expect(caught).toBe(original);
  }
});

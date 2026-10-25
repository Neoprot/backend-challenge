import { expect, test } from 'bun:test';
import { StructuredLogger } from '../../src/observability/logger';
import { runWithContext, currentContext } from '../../src/observability/context';
import { Metrics } from '../../src/observability/metrics';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import type { Observation } from '../../src/shared/application/observation';
import type { IdempotentUnitOfWork } from '../../src/wagering/application/idempotency';
import { ApplicationObservation } from '../../src/observability/observation';
import { ReferenceWorker } from '../../src/workers/reference-worker';

const payload = { providerId: 'aurora', externalTransactionId: 'external', walletId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
test('resultado financeiro só é observado após commit; replay não vira transição nova', async () => {
  const events: string[] = [];
  let committed = false, replay = false;
  const observation: Observation = { record: event => { expect(committed).toBe(true); events.push(event); } };
  const uow: IdempotentUnitOfWork = { runIdempotent: async () => {
    expect(events).toHaveLength(replay ? 1 : 0); committed = true;
    return { transactionId: 'tx', status: 'PROCESSED', terminal: true, httpStatus: 200, idempotentReplay: replay };
  } };
  const service = new SubmitWager(uow, { now: () => new Date() }, { next: () => 'tx' }, async () => {}, observation);
  await service.execute(payload, { idempotencyKey: 'key', correlationId: 'corr' });
  replay = true;
  await service.execute(payload, { idempotencyKey: 'key', correlationId: 'corr' });
  expect(events).toEqual(['transaction_committed', 'duplicate']);
});

test('rollback técnico não produz transição observada nem erro do observador repete commit', async () => {
  const events: string[] = []; let commits = 0;
  const failure = Object.assign(new Error('SQL privada'), { code: '23514' });
  const uow: IdempotentUnitOfWork = { runIdempotent: async () => { throw failure; } };
  const service = new SubmitWager(uow, { now: () => new Date() }, { next: () => 'tx' }, async () => {}, { record: event => { events.push(event); } });
  let received: unknown;
  try { await service.execute(payload, { idempotencyKey: 'key', correlationId: 'corr' }); } catch (error) { received = error; }
  expect(received).toBe(failure); expect(events).toEqual([]);
  uow.runIdempotent = async () => { commits++; return { transactionId: 'tx', status: 'PROCESSED', terminal: true, httpStatus: 200, idempotentReplay: false }; };
  const unsafe = new SubmitWager(uow, { now: () => new Date() }, { next: () => 'tx' }, async () => {}, { record: () => { throw new Error('sink'); } });
  expect((await unsafe.execute(payload, { idempotencyKey: 'key', correlationId: 'corr' })).status).toBe('PROCESSED'); expect(commits).toBe(1);
});

test('logger JSON omite segredos, objetos financeiros e mensagens de erro arbitrárias', () => {
  const lines: string[] = [], logger = new StructuredLogger(line => { lines.push(line); });
  const secret = 'segredo-que-nunca-deve-aparecer';
  logger.write('transaction_committed', { correlationId: 'safe-id', walletId: 'wallet-1', status: 'PROCESSED',
    authorization: secret, client_secret: secret, access_token: secret,
    body: { money: { amount: '123456.78', currency: 'BRL' }, authorization: secret },
    error: Object.assign(new Error('select * password=' + secret), { detail: secret }),
    payload: { playerId: 'player-private', balance: '123456.78' } });
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed).toMatchObject({ event: 'transaction_committed', correlationId: 'safe-id', walletId: 'wallet-1', status: 'PROCESSED' });
  for (const value of [secret, '123456.78', 'player-private', 'authorization', 'client_secret', 'access_token', 'select', 'body', 'payload']) expect(lines[0]!).not.toContain(value);
});

test('contexto permanece isolado em execuções concorrentes intercaladas e rejeita injeção', async () => {
  const lines: string[] = [], logger = new StructuredLogger(line => { lines.push(line); });
  await Promise.all(['first', 'second'].map((id, i) => runWithContext({ correlationId: id, messageId: id, providerId: 'aurora' }, async () => {
    await Bun.sleep(i === 0 ? 15 : 1);
    logger.write('transaction_committed', { transactionId: id, walletId: id });
    expect(currentContext()?.correlationId).toBe(id);
  })));
  expect(currentContext()).toBeUndefined();
  for (const line of lines) { const log = JSON.parse(line); expect(log.correlationId).toBe(log.transactionId); expect(log.messageId).toBe(log.walletId); }
  runWithContext({ correlationId: 'bad\r\nheader', messageId: 'bad\nvalue' }, () => logger.write('http_completed'));
  expect(JSON.parse(lines[2]!).messageId).toBeUndefined();
  expect(JSON.parse(lines[2]!).correlationId).toMatch(/^[a-f0-9-]{36}$/u);
});

test('métricas limitam séries e labels e preservam último lag conhecido em falha', () => {
  const metrics = new Metrics();
  metrics.transaction('PROCESSED', 'BET', false, 0.5);
  metrics.transaction('PROCESSED', 'BET', true, 0.1);
  metrics.retry('submit'); metrics.lockConflict('submit'); metrics.dlq('malformed'); metrics.reconciliation(false);
  metrics.setOutboxLag(7);
  expect(() => metrics.transaction('user-123' as never, 'wallet-456' as never, false, 1)).toThrow();
  expect(() => metrics.retry('provider-123' as never)).toThrow();
  const text = metrics.render();
  expect(text).toContain('wagering_transactions_total{status="PROCESSED",kind="BET"} 1');
  expect(text).toContain('wagering_duplicates_total 1');
  expect(text).toContain('wagering_outbox_lag_seconds 7');
  expect(text).toContain('wagering_reconciliation_divergences_total 1');
  for (const name of ['playerId', 'transactionId', 'walletId', 'providerId', 'user-123', 'wallet-456']) expect(text).not.toContain(name);
});

test('métricas e logger cobrem LOSS válido e uma única amostra de latência por operação', () => {
  const metrics = new Metrics(), lines: string[] = [];
  metrics.transaction('PROCESSED', 'LOSS', false, 0.25);
  new StructuredLogger(line => { lines.push(line); }).write('transaction_committed', { kind: 'LOSS', status: 'PROCESSED' });
  expect(metrics.render()).toContain('wagering_transactions_total{status="PROCESSED",kind="LOSS"} 1');
  expect(JSON.parse(lines[0]!).kind).toBe('LOSS');
});

test('observador registra exatamente uma duração no componente que executou a operação', () => {
  const metrics = new Metrics(), observation = new ApplicationObservation(new StructuredLogger(() => {}), metrics);
  observation.record('transaction_committed', { status: 'PROCESSED', kind: 'OPENING', component: 'opening', durationSeconds: 0.4 });
  expect(metrics.render()).toContain('wagering_duration_seconds_count{component="opening"} 1');
  expect(metrics.render()).not.toContain('component="submit"');
  observation.record('transaction_committed', { status: 'PROCESSED', kind: 'BET', component: 'submit', durationSeconds: 0.2 });
  expect(metrics.render()).toContain('wagering_duration_seconds_count{component="submit"} 1');
  expect(metrics.render()).toContain('wagering_duration_seconds_sum{component="submit"} 0.2');
  observation.record('transaction_committed', { status: 'PROCESSED', kind: 'REFUND', component: 'reference', durationSeconds: 0.3 });
  expect(metrics.render()).toContain('wagering_duration_seconds_count{component="reference"} 1');
  expect(metrics.render()).toContain('wagering_duration_seconds_count{component="submit"} 1');
});

test('ausência de duração não inventa amostra zero e FAILED mede o tempo real até o commit', async () => {
  const metrics = new Metrics(), observation = new ApplicationObservation(new StructuredLogger(() => {}), metrics);
  observation.record('transaction_committed', { status: 'FAILED', kind: 'BET', component: 'submit' });
  expect(metrics.render()).not.toContain('wagering_duration_seconds_count{');
  const uow: IdempotentUnitOfWork = { runIdempotent: async () => {
    await Bun.sleep(20); return { transactionId: 'tx', status: 'FAILED', terminal: true, httpStatus: 500, idempotentReplay: false };
  } };
  const service = new SubmitWager(uow, { now: () => new Date() }, { next: () => 'tx' }, async () => {}, observation);
  await service.recordPermanentFailure(payload, { idempotencyKey: 'key', correlationId: 'corr' });
  expect(metrics.render()).toContain('wagering_duration_seconds_count{component="submit"} 1');
  const sum = Number(metrics.render().split('\n').find(line => line.startsWith('wagering_duration_seconds_sum{component="submit"}'))!.split(' ').at(-1));
  expect(sum).toBeGreaterThanOrEqual(0.015);
});

test('falha individual de referência é observada dentro do contexto sem expor o erro', async () => {
  const lines: string[] = [], observation = new ApplicationObservation(new StructuredLogger(line => { lines.push(line); }));
  const failure = new Error('password=nao-expor-reference');
  const worker = new ReferenceWorker({ claim: async () => ['known-transaction'] }, { reprocessPending: async () => { throw failure; } },
    { next: () => 'owner' }, undefined, { observation });
  for (let attempt = 0; attempt < 2; attempt++) {
    let caught: unknown; try { await worker.pollOnce(); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  }
  const failures = lines.map(line => JSON.parse(line)).filter(log => log.event === 'worker_failed');
  expect(failures).toHaveLength(2);
  expect(failures[0]).toMatchObject({ component: 'reference', transactionId: 'known-transaction', correlationId: 'known-transaction' });
  expect(lines.join('\n')).not.toContain('nao-expor-reference');
});

test('enriquecimento de IDs fica local à execução concorrente e ao escopo filho', async () => {
  const observation = new ApplicationObservation(new StructuredLogger(() => {}));
  await Promise.all(['one', 'two'].map(id => runWithContext({ correlationId: id }, async () => {
    observation.executionContext({ walletId: id, providerId: 'aurora' });
    await Bun.sleep(id === 'one' ? 15 : 1);
    expect(currentContext()).toMatchObject({ correlationId: id, walletId: id, providerId: 'aurora' });
    const snapshot = currentContext()!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    runWithContext({ correlationId: 'child' }, () => { observation.executionContext({ walletId: 'child' }); expect(currentContext()?.walletId).toBe('child'); });
    expect(currentContext()?.walletId).toBe(id);
  })));
  expect(currentContext()).toBeUndefined();
});

test('falha do sink não altera o resultado da execução observada', () => {
  expect(() => new StructuredLogger(() => { throw new Error('sink indisponível'); }).write('http_completed')).not.toThrow();
});

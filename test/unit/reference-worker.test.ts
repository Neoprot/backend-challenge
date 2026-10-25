import { expect, test } from 'bun:test';
import { ReferenceWorker } from '../../src/workers/reference-worker';
test('claim bounded usa relógio injetado e processa itens independentes em paralelo', async () => {
  const now = new Date('2026-10-25T12:00:00Z');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const worker = new ReferenceWorker({ claim: async options => {
    expect(options).toMatchObject({ owner: 'owner', now, limit: 2, leaseMs: 30000 }); return ['a', 'b'];
  } }, { reprocessPending: async id => { calls.push(id); if (id === 'a') await blocked; } },
  { next: () => 'owner' }, { now: () => now }, { batchSize: 2 });
  const running = worker.pollOnce();
  try { for (let i = 0; i < 10; i++) await Promise.resolve(); expect(calls).toEqual(['a', 'b']); }
  finally { release(); await running; }
  expect(await running).toBe(2);
});

test('falha técnica aguarda outros itens; stop aguarda drain e impede novos claims', async () => {
  let release!: () => void, claims = 0, settled = false;
  const hold = new Promise<void>(resolve => { release = resolve; }), failure = new Error('Conexão indisponível');
  const worker = new ReferenceWorker({ claim: async () => { claims++; return ['a', 'b']; } },
    { reprocessPending: async id => { if (id === 'a') throw failure; await hold; } }, { next: () => 'owner' });
  let caught: unknown;
  const running = worker.pollOnce().catch(error => { caught = error; }).finally(() => { settled = true; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(await worker.stop(0)).toEqual({ drained: false });
  expect(await worker.pollOnce()).toBe(0);
  release(); await running;
  expect(caught).toBe(failure);
  expect(await worker.stop(100)).toEqual({ drained: true });
  expect(claims).toBe(1);
});

test('limites de lote e lease impedem claims sem limite', () => {
  const make = (options: { batchSize?: number; leaseMs?: number }) => new ReferenceWorker({ claim: async () => [] }, { reprocessPending: async () => {} }, { next: () => 'owner' }, undefined, options);
  expect(() => make({ batchSize: 0 })).toThrow(); expect(() => make({ batchSize: 51 })).toThrow();
  expect(() => make({ leaseMs: 99 })).toThrow(); expect(() => make({ leaseMs: 300001 })).toThrow();
});

import { expect, test } from 'bun:test';
import { Barrier } from '../support/barrier';
test('barreira só libera participantes após todas as chegadas e liberação explícita', async () => {
  const barrier = new Barrier(2); let completed = 0;
  const first = barrier.arriveAndWait().then(() => { completed++; });
  await Promise.resolve(); expect(completed).toBe(0);
  expect(() => barrier.release()).toThrow();
  const second = barrier.arriveAndWait().then(() => { completed++; });
  await barrier.ready; expect(completed).toBe(0);
  barrier.release(); await Promise.all([first, second]); expect(completed).toBe(2);
  expect(() => barrier.arriveAndWait()).toThrow();
});

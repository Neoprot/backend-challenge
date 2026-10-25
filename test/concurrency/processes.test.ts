import { test, expect } from 'bun:test';
import { HarnessNode, ProcessHarness, within } from '../support/processes';
test('harness fornece três processos, portas e sessões PostgreSQL independentes prontos', async () => {
  const harness = new ProcessHarness();
  try {
    await harness.start();
    expect(harness.nodes).toHaveLength(3);
    expect(new Set(harness.nodes.map(node => node.pid)).size).toBe(3);
    expect(new Set(harness.nodes.map(node => node.databasePid)).size).toBe(3);
    expect(new Set(harness.nodes.map(node => node.base)).size).toBe(3);
    for (const node of harness.nodes) expect((await fetch(node.base + '/health/ready')).status).toBe(200);
  } finally { await harness.close(); }
});
test('filho encerra se perder IPC do supervisor, evitando processo órfão', async () => {
  const harness = new ProcessHarness();
  try {
    await harness.start(1);
    const node = harness.nodes[0]!;
    node.process.disconnect();
    expect(await within(node.process.exited, 2000, 'Filho permaneceu órfão após desconectar IPC.')).toBe(0);
  } finally { await harness.close(); }
});
test('filho encerra ao perder supervisor durante startup bloqueado, antes de ready', async () => {
  const node = new HarnessNode(new URL('../support/process-blocked-child.ts', import.meta.url));
  try {
    await node.startupBlocked();
    node.process.disconnect();
    expect(await within(node.process.exited, 1000, 'Filho ficou órfão antes de ready.')).toBe(0);
  } finally { await node.close(); }
});
test('desconexão imediata após spawn também encerra o filho antes de ready', async () => {
  const node = new HarnessNode(new URL('../support/process-blocked-child.ts', import.meta.url));
  try {
    node.process.disconnect();
    expect(await within(node.process.exited, 2000, 'Filho ficou órfão durante os imports.')).toBe(0);
  } finally { await node.close(); }
});

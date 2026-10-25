import { expect, test } from 'bun:test';
import { assertTestService, loopbackPort, startLinuxRuntime, type ContainerInspection, type docker } from '../support/linux-runtime';
const inspection = (): ContainerInspection => ({
  Config: { Labels: { 'com.docker.compose.project': 'wagering-test', 'com.docker.compose.service': 'postgres' } },
  State: { Running: true, ExitCode: 0, Health: { Status: 'healthy' } },
  NetworkSettings: { Networks: { 'wagering-test_default': { IPAddress: '172.20.0.2' } },
    Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } },
});
test('harness Linux recusa serviço de outro projeto antes de operar containers', () => {
  const record = inspection(); record.Config.Labels['com.docker.compose.project'] = 'wagering-dev';
  expect(() => assertTestService(record, 'postgres')).toThrow();
});
test('harness Linux exige serviço correto, rede exclusiva e estado saudável', () => {
  expect(() => assertTestService(inspection(), 'postgres')).not.toThrow();
  for (const change of [
    (record: ContainerInspection) => { record.Config.Labels['com.docker.compose.service'] = 'keycloak'; },
    (record: ContainerInspection) => { record.NetworkSettings.Networks = { other: { IPAddress: '172.20.0.2' } }; },
    (record: ContainerInspection) => { record.State.Health = { Status: 'unhealthy' }; },
  ]) { const record = inspection(); change(record); expect(() => assertTestService(record, 'postgres')).toThrow(); }
});
test('harness Linux aceita somente a porta publicada em loopback', () => {
  expect(loopbackPort(inspection())).toBe(49152);
  const record = inspection(); record.NetworkSettings.Ports!['3000/tcp']![0]!.HostIp = '0.0.0.0';
  expect(() => loopbackPort(record)).toThrow();
});
test('harness Linux remove seu container se run falhar depois de criá-lo', async () => {
  const failure = new Error('Falha de transporte após create');
  let name = '', owner = '', removed = false;
  const command: typeof docker = async args => {
    if (args[0] === 'run') {
      name = args[args.indexOf('--name') + 1]!;
      owner = args.find(value => value.startsWith('wagering.test.run='))!.split('=')[1]!;
      throw failure;
    }
    if (args[0] === 'inspect') {
      expect(args[1]).toBe(name);
      const record = inspection(); record.Config.Labels['com.docker.compose.service'] = 'signal-runtime';
      record.Config.Labels['wagering.test.run'] = owner;
      return JSON.stringify([record]);
    }
    if (args[0] === 'rm') { expect(args).toEqual(['rm', '--force', name]); removed = true; return name; }
    throw new Error('Comando inesperado no adaptador unitário.');
  };
  let caught: unknown;
  try { await startLinuxRuntime({ request: 'http://127.0.0.1:4567/request.fifo', dlq: 'http://127.0.0.1:4567/dlq.fifo', events: 'http://127.0.0.1:4567/events.fifo' }, 1000, command); }
  catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(removed).toBe(true);
});

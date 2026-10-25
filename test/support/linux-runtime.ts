export interface ContainerInspection {
  Config: { Labels: Record<string, string> };
  State: { Running: boolean; ExitCode: number; Health?: { Status: string } };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }>; Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
}
export function assertTestService(inspection: ContainerInspection, service: string): void {
  if (inspection.Config.Labels['com.docker.compose.project'] !== 'wagering-test'
    || inspection.Config.Labels['com.docker.compose.service'] !== service
    || !inspection.State.Running || inspection.State.Health?.Status !== 'healthy'
    || !inspection.NetworkSettings.Networks['wagering-test_default']) {
    throw new Error('Harness Linux exige serviço saudável do projeto exclusivo wagering-test.');
  }
}
export function loopbackPort(inspection: ContainerInspection): number {
  const bindings = inspection.NetworkSettings.Ports?.['3000/tcp'];
  const port = Number(bindings?.[0]?.HostPort);
  if (bindings?.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1'
    || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta Linux deve estar publicada somente em loopback.');
  return port;
}

import { testEnvironment } from './environment';
const image = 'wagering-signal-test:local';
class DockerCommandError extends Error {
  readonly notFound: boolean;
  constructor(operation: string | undefined, code: number, stderr: string) {
    super(`Docker ${operation} falhou (${code}): ${stderr.slice(-2500)}`);
    this.notFound = operation === 'inspect' && code === 1 && /No such (object|container)/u.test(stderr);
  }
}
export async function docker(args: readonly string[], environment: Record<string, string | undefined> = {}, timeoutMs = 30000): Promise<string> {
  const child = Bun.spawn(['docker', ...args], { env: { ...process.env, ...environment }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, output, errors]);
    if (code !== 0) throw new DockerCommandError(args[0], code, stderr);
    return (args[0] === 'logs' ? `${stdout}\n${stderr}` : stdout).trim();
  } finally { clearTimeout(timer); }
}
async function inspect(id: string, command = docker): Promise<ContainerInspection> {
  const records: unknown = JSON.parse(await command(['inspect', id]));
  if (!Array.isArray(records) || records.length !== 1) throw new Error('Resposta de inspeção Docker inválida.');
  return records[0] as ContainerInspection;
}
export async function prepareLinuxRuntime(): Promise<void> {
  testEnvironment();
  for (const service of ['postgres', 'localstack', 'keycloak']) {
    const id = await docker(['compose', '-f', 'compose.yaml', '-f', 'compose.test.yaml', 'ps', '--quiet', service]);
    if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error('Serviço exclusivo de teste não encontrado.');
    assertTestService(await inspect(id), service);
  }
  await docker(['build', '-t', image, '.'], {}, 180000);
}
function internalUrl(value: string, hostname: string, port: string): string {
  const url = new URL(value); url.hostname = hostname; url.port = port; return url.toString();
}
export async function startLinuxRuntime(queues: { request: string; dlq: string; events: string }, graceMs = 15000, command = docker) {
  const env = testEnvironment(), runId = crypto.randomUUID(), name = `wagering-signal-${runId}`;
  const environment = {
    DATABASE_URL: internalUrl(env.databaseUrl, 'postgres', '5432'), SQS_ENDPOINT: 'http://localstack:4566',
    OIDC_ISSUER: env.issuer, OIDC_AUDIENCE: 'wagering-api', OIDC_JWKS_URI: 'http://keycloak:8080/realms/wagering/protocol/openid-connect/certs',
    PORT: '3000', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
    REQUEST_QUEUE_URL: internalUrl(queues.request, 'localstack', '4566'), REQUEST_DLQ_URL: internalUrl(queues.dlq, 'localstack', '4566'),
    EVENT_QUEUE_URL: internalUrl(queues.events, 'localstack', '4566'), WORKER_CONSUMER_NAME: `signal-${runId}`,
    WORKER_VISIBILITY_SECONDS: '2', WORKER_HEARTBEAT_MS: '300', WORKER_SHUTDOWN_GRACE_MS: String(graceMs),
  };
  // O nome e o owner existem antes da RPC: run pode criar o recurso e perder a resposta.
  let id = name;
  const owned = async () => {
    const record = await inspect(id, command);
    if (record.Config.Labels['wagering.test.run'] !== runId || record.Config.Labels['com.docker.compose.project'] !== 'wagering-test'
      || record.Config.Labels['com.docker.compose.service'] !== 'signal-runtime') throw new Error('Container não pertence a esta execução de teste.');
    return record;
  };
  const runtime = {
    get id() { return id; }, consumerName: environment.WORKER_CONSUMER_NAME, url: '', address: '',
    inspect: owned,
    signal: async () => { await owned(); await command(['kill', '--signal', 'SIGTERM', id]); },
    logs: async () => command(['logs', id]),
    close: async () => {
      try { await owned(); }
      catch (error) { if (error instanceof DockerCommandError && error.notFound) return; throw error; }
      await command(['rm', '--force', id]);
    },
  };
  try {
    id = await command(['run', '--detach', '--name', name, '--network', 'wagering-test_default', '--publish', '127.0.0.1::3000',
      '--label', 'com.docker.compose.project=wagering-test', '--label', 'com.docker.compose.service=signal-runtime',
      '--label', `wagering.test.run=${runId}`, ...Object.keys(environment).flatMap(key => ['--env', key]), image, 'bun', 'src/workers/main.ts'], environment);
    const record = await owned(); runtime.url = `http://127.0.0.1:${loopbackPort(record)}`;
    runtime.address = record.NetworkSettings.Networks['wagering-test_default']?.IPAddress ?? '';
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (!(await owned()).State.Running) throw new Error('Runtime Linux encerrou antes de ficar pronto.');
      try { if ((await fetch(`${runtime.url}/health/ready`, { signal: AbortSignal.timeout(2000) })).status === 200) return runtime; }
      catch { /* Startup ainda pode estar abrindo a porta HTTP. */ }
      await Bun.sleep(50);
    }
    throw new Error('Runtime Linux não ficou pronto no prazo.');
  } catch (error) {
    try { await runtime.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Falha no runtime Linux e no cleanup exclusivo.'); }
    throw error;
  }
}

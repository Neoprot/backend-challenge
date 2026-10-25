import { testEnvironment } from './environment';
import { accessToken } from './identity';
type Service = 'postgres' | 'localstack';
async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['rtk', 'proxy', 'docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Docker falhou (${exit}): ${stderr}`);
  return stdout;
}
const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.test.yaml'];
export async function withOutage(service: Service, work: (restore: () => Promise<void>) => Promise<void>): Promise<void> {
  testEnvironment();
  const id = (await docker([...compose, 'ps', '-q', service])).trim();
  if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error('Container exclusivo não encontrado');
  const rows = JSON.parse(await docker(['inspect', id])) as { Config: { Labels: Record<string, string> } }[];
  const labels = rows[0]?.Config.Labels;
  if (labels?.['com.docker.compose.project'] !== 'wagering-test' || labels['com.docker.compose.service'] !== service) throw new Error('Recusa de outage fora do projeto wagering-test');
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await docker([...compose, 'start', '--wait', '--wait-timeout', '120', service]);
    const states = JSON.parse(await docker(['inspect', id])) as { State: { Running: boolean; Health?: { Status: string } } }[];
    if (!states[0]?.State.Running || states[0].State.Health?.Status !== 'healthy') throw new Error('Serviço não recuperou saúde');
    if (service === 'postgres') {
      let healthy = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { await accessToken(); healthy = true; break; } catch { await Bun.sleep(1000); }
      }
      if (!healthy) throw new Error('Keycloak não voltou a emitir token real');
    }
    restored = true;
  };
  try { await docker([...compose, 'stop', service]); await work(restore); }
  finally { await restore(); }
}

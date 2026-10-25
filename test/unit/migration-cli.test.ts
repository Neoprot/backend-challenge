import { expect, test } from 'bun:test';

async function invoke(action: string) {
  const process = Bun.spawn([Bun.argv[0]!, 'scripts/migrate.ts', action], {
    env: { ...Bun.env, MIGRATION_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { exitCode, stderr };
}
test('CLI de migrations rejeita ação desconhecida antes de conectar', async () => {
  const result = await invoke('reset');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Ação inválida');
});
test('CLI de migrations exige configuração explícita', async () => {
  const result = await invoke('up');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('MIGRATION_DATABASE_URL obrigatória');
});

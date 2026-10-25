import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('setup portátil cria .env e preserva exatamente o arquivo existente na segunda execução', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wager-env-'));
  try {
    await writeFile(join(directory, '.env.example'), 'EXEMPLO=local\n');
    const script = await readFile(new URL('../../scripts/setup-env.ts', import.meta.url), 'utf8');
    await writeFile(join(directory, 'setup-env.ts'), script.replaceAll("new URL('../", "new URL('./"));
    const execute = async () => {
      const child = Bun.spawn([process.execPath, join(directory, 'setup-env.ts')], { stdout: 'pipe', stderr: 'pipe' });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(errors).toBe(''); expect(code).toBe(0);
      return output;
    };
    expect(await execute()).toContain('criado');
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe('EXEMPLO=local\n');
    await writeFile(join(directory, '.env'), 'MINHA_CONFIGURAÇÃO=preservada\n');
    expect(await execute()).toContain('preservado');
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe('MINHA_CONFIGURAÇÃO=preservada\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import { testEnvironment } from '../test/support/environment';
testEnvironment();
const files: string[] = [];
for await (const file of new Bun.Glob('test/concurrency/**/*.test.ts').scan('.')) files.push(file);
const signals = files.filter(file => file.endsWith('signals.test.ts'));
const native = files.filter(file => !file.endsWith('signals.test.ts')).sort();
if (!native.length) throw new Error('Nenhum teste de concorrência nativo encontrado.');
// O runtime Linux possui scans globais; deve executar depois que todas as fixtures nativas encerraram.
for (const batch of [native, signals]) {
  if (!batch.length) continue;
  const child = Bun.spawn([process.execPath, 'test', ...batch, '--timeout', '60000'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const exit = await child.exited;
  if (exit !== 0) process.exit(exit);
}

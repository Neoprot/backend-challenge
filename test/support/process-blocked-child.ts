import { runHarnessChild } from './process-child';
// Dependência injetada apenas neste executável de teste; simula startup ainda aguardando I/O.
await runHarnessChild(async () => {
  const keepAlive = setInterval(() => {}, 1000);
  process.send!({ type: 'stage', stage: 'startup-blocked' });
  try { await new Promise<void>(() => {}); }
  finally { clearInterval(keepAlive); }
});

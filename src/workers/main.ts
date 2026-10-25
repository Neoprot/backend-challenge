import 'reflect-metadata';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createApplication } from '../bootstrap/main';
import { readConfiguration } from '../bootstrap/config';
import { ORM, SQS } from '../bootstrap/tokens';
import { SubmitWager } from '../wagering/application/submit-wager';
import { createWorkerRuntime, readWorkerConfiguration } from './worker-runtime';

/** Entry point explícito: HTTP autenticado + consumer de comandos + publisher de eventos. */
export async function bootstrapWorkers() {
  const configuration = readConfiguration(process.env), workers = readWorkerConfiguration(process.env);
  const app = await createApplication(configuration);
  const runtime = createWorkerRuntime(workers, app.get<MikroORM>(ORM), app.get<SQSClient>(SQS), app.get(SubmitWager));
  try { await app.listen(configuration.port, '0.0.0.0'); runtime.start(); }
  catch (error) { await runtime.stop(workers.shutdownGraceMs); await app.close(); throw error; }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    // Inclui drain e close HTTP/SQL no limite total; não fecha o pool com SQL ainda ativa.
    const watchdog = setTimeout(() => process.exit(1), workers.shutdownGraceMs);
    const reserve = Math.min(1500, Math.floor(workers.shutdownGraceMs / 4));
    try {
      const result = await runtime.stop(workers.shutdownGraceMs - reserve);
      if (!result.drained) { process.exitCode = 1; return; }
      await app.close(); clearTimeout(watchdog);
      process.removeListener('SIGTERM', handler); process.removeListener('SIGINT', handler);
    } catch { process.exitCode = 1; /* O watchdog encerra sockets do próprio processo no prazo. */ }
  };
  const handler = () => { void shutdown(); };
  process.once('SIGTERM', handler); process.once('SIGINT', handler);
  return { app, runtime, shutdown };
}
if (import.meta.main) await bootstrapWorkers();

import type { MikroORM } from '@mikro-orm/postgresql';
/** Apenas leituras próprias; cancelamento público da consulta, nunca encerramento de sessões. */
export async function boundedRead<T extends Record<string, unknown>[]>(orm: MikroORM, sql: string, parameters: unknown[] = [], timeoutMs = 1000): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await orm.em.fork().execute<T>(sql, parameters, { signal: controller.signal, inflightQueryAbortStrategy: 'cancel query' }); }
  finally { clearTimeout(timer); }
}

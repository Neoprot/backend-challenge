import type { MikroORM } from '@mikro-orm/postgresql';
import type { ReferenceStore, ReferenceClaimOptions } from '../wagering/application/reference-store';
export class PostgresReferenceStore implements ReferenceStore {
  constructor(private readonly orm: MikroORM) {}
  async claim(options: ReferenceClaimOptions): Promise<string[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50 ||
      !Number.isInteger(options.leaseMs) || options.leaseMs < 100 || options.leaseMs > 300000) throw new Error('Lote ou lease fora dos limites.');
    if (options.ids?.length === 0) return [];
    const scope = options.ids ? `and id in (${options.ids.map(() => '?').join(',')})` : '';
    // Autocommit libera SKIP LOCKED antes de qualquer tentativa de bloquear a carteira.
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(`with clock as (select coalesce(?::timestamptz, statement_timestamp()) as now),
      due as (select id from wager_transaction, clock where status = 'PENDING_REFERENCE'
        and (next_attempt_at <= clock.now or reference_deadline <= clock.now)
        and (lease_until is null or lease_until <= clock.now) ${scope}
        order by next_attempt_at, id limit ? for update skip locked)
      update wager_transaction w set lease_owner = ?::uuid, lease_until = clock.now + (? * interval '1 millisecond')
      from due, clock where w.id = due.id returning w.id`,
      [options.now ?? null, ...(options.ids ?? []), options.limit, options.owner, options.leaseMs]);
    return rows.map(row => row.id);
  }
}

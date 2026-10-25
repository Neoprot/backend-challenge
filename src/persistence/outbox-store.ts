import type { MikroORM } from '@mikro-orm/postgresql';
import type { ClaimOptions, OutboxStore } from '../messaging/application/outbox-store';
import { OutboxMessage, type JsonValue } from '../messaging/domain/outbox-message';
interface OutboxRow {
  id: string; aggregate_id: string; event_type: string; payload: JsonValue; occurred_at: Date;
  attempts: number; next_attempt_at: Date | null; published_at: Date | null; lease_owner: string | null; lease_until: Date | null;
}
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}
  async claim(options: ClaimOptions): Promise<OutboxMessage[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50 ||
      !Number.isInteger(options.leaseMs) || options.leaseMs < 100 || options.leaseMs > 300000) throw new Error('Lote ou lease fora dos limites');
    if (options.ids?.length === 0) return [];
    // Um único statement em autocommit: o claim termina antes de qualquer chamada de rede.
    // Produção usa relógio PostgreSQL; now explícito existe para testes determinísticos.
    const scope = options.ids ? `and id in (${options.ids.map(() => '?').join(',')})` : '';
    const rows = await this.orm.em.fork().execute<OutboxRow[]>(`with clock as (select coalesce(?::timestamptz, statement_timestamp()) as now),
      due as (select id from outbox_message, clock where published_at is null
        and (next_attempt_at is null or next_attempt_at <= clock.now)
        and (lease_until is null or lease_until <= clock.now) ${scope}
        order by occurred_at, id limit ? for update skip locked)
      update outbox_message o set lease_owner = ?::uuid, lease_until = clock.now + (? * interval '1 millisecond')
      from due, clock where o.id = due.id returning o.*`,
      [options.now ?? null, ...(options.ids ?? []), options.limit, options.owner, options.leaseMs]);
    return rows.map(row => OutboxMessage.rehydrate({ id: row.id, aggregateId: row.aggregate_id, eventType: row.event_type, payload: row.payload,
      occurredAt: new Date(row.occurred_at), attempts: row.attempts, nextAttemptAt: row.next_attempt_at === null ? null : new Date(row.next_attempt_at),
      publishedAt: row.published_at === null ? null : new Date(row.published_at), leaseOwner: row.lease_owner, leaseUntil: row.lease_until === null ? null : new Date(row.lease_until) }));
  }
  async markPublished(id: string, owner: string, now?: Date): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(`with clock as (select coalesce(?::timestamptz, statement_timestamp()) as now)
      update outbox_message set published_at = clock.now, next_attempt_at = null, lease_owner = null, lease_until = null
      from clock where id = ?::uuid and lease_owner = ?::uuid and lease_until > clock.now and published_at is null returning id`, [now ?? null, id, owner]);
    return rows.length === 1;
  }
  async fail(id: string, owner: string, now?: Date): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<{ id: string }[]>(`with clock as (select coalesce(?::timestamptz, statement_timestamp()) as now)
      update outbox_message set attempts = attempts + 1,
        next_attempt_at = clock.now + (least(300000, 1000 * power(2, least(attempts, 9))) * interval '1 millisecond'),
        lease_owner = null, lease_until = null from clock
      where id = ?::uuid and lease_owner = ?::uuid and lease_until > clock.now and published_at is null returning id`, [now ?? null, id, owner]);
    return rows.length === 1;
  }
}

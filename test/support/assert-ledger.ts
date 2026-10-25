import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

export async function assertLedger(orm: MikroORM, walletId: string): Promise<void> {
  const rows = await orm.em.fork().execute<{ balance: string; ledger: string }[]>(`
    select w.balance::text as balance,
      coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(30,2)::text as ledger
    from wallet w left join wallet_ledger_entry l on l.wallet_id = w.id
    where w.id = ? group by w.id`, [walletId]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.balance).toBe(rows[0]!.ledger);
}

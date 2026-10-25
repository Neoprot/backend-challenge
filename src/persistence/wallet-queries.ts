import type { MikroORM } from '@mikro-orm/postgresql';
import type { WalletQueries, WalletView, LedgerView, LedgerPosition, ReconciliationView } from '../wallets/application/wallet-queries';
import { WalletRecord } from './records';
import { Money } from '../shared/domain/money';
import type { LedgerDirection } from '../wallets/domain/ledger-entry';
export class PostgresWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}
  async readWallet(walletId: string): Promise<WalletView | undefined> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    return record === null ? undefined : { id: record.id, playerId: record.playerId, balance: Money.rehydrate({ amount: record.balance, currency: record.currency }).toJSON(), version: record.version };
  }
  async listLedger(walletId: string, limit: number, position?: LedgerPosition): Promise<LedgerView[]> {
    const rows = await this.orm.em.fork().execute<LedgerRow[]>(`select l.id, l.wallet_id, l.transaction_id, l.direction, l.currency,
      l.amount::text, l.balance_before::text, l.balance_after::text,
      to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      from wallet_ledger_entry l where l.wallet_id = ?
      ${position === undefined ? '' : 'and (l.created_at, l.id) < (?::timestamptz, ?::uuid)'}
      order by l.created_at desc, l.id desc limit ?`,
      position === undefined ? [walletId, limit] : [walletId, position.createdAt, position.id, limit]);
    return rows.map(row => ({ id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id, direction: row.direction,
      money: { amount: row.amount, currency: row.currency }, balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency }, createdAt: row.created_at }));
  }
  async reconcile(walletId: string): Promise<ReconciliationView | undefined> {
    // Um único SELECT usa o mesmo snapshot MVCC para saldo e lançamentos.
    const rows = await this.orm.em.fork().execute<ReconciliationRow[]>(`select w.id, w.currency, w.balance::text as stored,
      coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(30,2)::text as calculated,
      count(l.id)::text as entries from wallet w left join wallet_ledger_entry l on l.wallet_id = w.id
      where w.id = ? group by w.id`, [walletId]);
    const row = rows[0];
    if (row === undefined) return undefined;
    const stored = Money.rehydrate({ amount: row.stored, currency: row.currency });
    const calculated = Money.rehydrate({ amount: row.calculated, currency: row.currency });
    const checkedEntries = Number(row.entries);
    if (!Number.isSafeInteger(checkedEntries)) throw new Error('Contagem de lançamentos fora do limite de serialização.');
    return { walletId: row.id, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(), consistent: stored.equals(calculated), checkedEntries };
  }
}
interface LedgerRow { id: string; wallet_id: string; transaction_id: string; direction: LedgerDirection; currency: string; amount: string; balance_before: string; balance_after: string; created_at: string; }
interface ReconciliationRow { id: string; currency: string; stored: string; calculated: string; entries: string; }

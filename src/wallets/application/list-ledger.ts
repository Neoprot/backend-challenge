import type { WalletQueries, LedgerView } from './wallet-queries';
import { ledgerLimit, encodeLedgerCursor, decodeLedgerCursor } from './ledger-cursor';
import { ReadWallet } from './read-wallet';
export interface LedgerPage { items: LedgerView[]; nextCursor?: string; }
export class ListLedger {
  constructor(private readonly queries: WalletQueries) {}
  async execute(walletId: string, options: { cursor?: unknown; limit?: unknown } = {}): Promise<LedgerPage> {
    const limit = ledgerLimit(options.limit);
    const position = options.cursor === undefined ? undefined : decodeLedgerCursor(options.cursor, walletId);
    await new ReadWallet(this.queries).execute(walletId);
    const rows = await this.queries.listLedger(walletId, limit + 1, position);
    const items = rows.slice(0, limit);
    if (rows.length <= limit) return { items };
    const last = items[items.length - 1]!;
    return { items, nextCursor: encodeLedgerCursor({ version: 1, walletId, id: last.id, createdAt: last.createdAt }) };
  }
}

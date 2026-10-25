import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerRecord } from './records';
import { Money } from '../shared/domain/money';
import type { TransactionQueries, TransactionView } from '../wagering/application/read-transaction';
import type { ProcessingResult } from '../wagering/application/processing-result';

export class PostgresTransactionQueries implements TransactionQueries {
  constructor(private readonly orm: MikroORM) {}
  async byId(id: string): Promise<TransactionView | undefined> { return this.view(await this.orm.em.fork().findOne(WagerRecord, { id })); }
  async byExternal(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined> {
    return this.view(await this.orm.em.fork().findOne(WagerRecord, { providerId, externalTransactionId }));
  }
  private view(row: WagerRecord | null): TransactionView | undefined {
    if (row === null) return undefined;
    return { id: row.id, providerId: row.providerId, externalTransactionId: row.externalTransactionId,
      playerId: row.playerId, walletId: row.walletId, roundId: row.roundId, gameId: row.gameId, kind: row.kind,
      money: Money.rehydrate({ amount: row.amount, currency: row.currency }).toJSON(), status: row.status,
      createdAt: row.createdAt.toISOString(),
      ...(row.referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId: row.referenceExternalTransactionId }),
      ...(row.referenceTransactionId === null ? {} : { referenceTransactionId: row.referenceTransactionId }),
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
      ...(row.processedAt === null ? {} : { processedAt: row.processedAt.toISOString() }),
      // Snapshot produzido pelo caso de uso e persistido na mesma transação financeira.
      ...(row.result === null ? {} : { result: structuredClone(row.result) as unknown as ProcessingResult }),
    };
  }
}

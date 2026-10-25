import type { MoneyProps } from '../../shared/domain/money';
import type { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { FailureCode } from '../domain/failure-code';
import type { ProcessingResult } from './processing-result';
import { ApplicationError } from '../../shared/application/application-error';

export interface TransactionView {
  id: string; providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerTransactionKind; money: MoneyProps; status: WagerTransactionStatus;
  referenceExternalTransactionId?: string; referenceTransactionId?: string; failureCode?: FailureCode;
  createdAt: string; processedAt?: string; result?: ProcessingResult;
}
export interface TransactionQueries {
  byId(id: string): Promise<TransactionView | undefined>;
  byExternal(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined>;
}
export class ReadTransaction {
  constructor(private readonly queries: TransactionQueries) {}
  async byId(id: string): Promise<TransactionView> { return this.required(await this.queries.byId(id)); }
  async byExternal(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.required(await this.queries.byExternal(providerId, externalTransactionId));
  }
  private required(value: TransactionView | undefined): TransactionView {
    if (value === undefined) throw new ApplicationError('TRANSACTION_NOT_FOUND', 'Transação não encontrada.', 404);
    return value;
  }
}

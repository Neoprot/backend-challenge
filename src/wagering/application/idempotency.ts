import type { FinancialSession } from '../../shared/application/unit-of-work';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { ProcessingResult, ProcessingResponse } from './processing-result';
import { DomainError } from '../../shared/domain/domain-error';

export interface IdempotentUnitOfWork {
  runIdempotent(transaction: WagerTransaction, work: (session: FinancialSession) => Promise<ProcessingResult>, options?: { lockWallet: boolean }): Promise<ProcessingResponse>;
}
export class IdempotencyConflict extends DomainError {
  readonly httpStatus = 409;
  constructor(code: 'IDEMPOTENCY_IDENTITY_CONFLICT' | 'IDEMPOTENCY_PAYLOAD_CONFLICT') {
    super(code, 'Identidade ou conteúdo diverge da transação já recebida.');
  }
}

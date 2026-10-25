import type { FinancialSession } from '../../shared/application/unit-of-work';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { ProcessingResult, ProcessingResponse } from './processing-result';
import { DomainError } from '../../shared/domain/domain-error';
import type { InboxContext } from '../../messaging/domain/inbox-message';

export interface IdempotentOptions { lockWallet: boolean; inbox?: InboxContext; }

export interface IdempotentUnitOfWork {
  runPending?(id: string, owner: string, now: (() => Date) | undefined, work: (transaction: WagerTransaction, session: FinancialSession,
    context: { correlationId: string; causationId?: string }, expired: boolean) => Promise<ProcessingResult>): Promise<void>;
  runIdempotent(transaction: WagerTransaction, work: (session: FinancialSession) => Promise<ProcessingResult>, options?: IdempotentOptions): Promise<ProcessingResponse>;
}
export class IdempotencyConflict extends DomainError {
  readonly httpStatus = 409;
  constructor(code: 'IDEMPOTENCY_IDENTITY_CONFLICT' | 'IDEMPOTENCY_PAYLOAD_CONFLICT') {
    super(code, 'Identidade ou conteúdo diverge da transação já recebida.');
  }
}

import type { WagerTransactionStatus } from '../domain/wager-transaction';
import type { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../../shared/domain/money';
export interface ProcessingResult { transactionId: string; status: WagerTransactionStatus; failureCode?: FailureCode; balance?: MoneyProps; httpStatus: number; terminal: boolean; }
export type ProcessingResponse = ProcessingResult & { idempotentReplay: boolean };
export function processingResponse(result: ProcessingResult, replay: boolean): ProcessingResponse {
  return { ...structuredClone(result), idempotentReplay: replay };
}

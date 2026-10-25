import { DomainError } from '../../shared/domain/domain-error';
import type { Wallet } from '../../wallets/domain/wallet';
import type { LedgerDirection } from '../../wallets/domain/ledger-entry';
import type { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';

export type WagerDecision = { type: 'apply'; direction: LedgerDirection | null } | { type: 'wait' } | { type: 'reject'; failureCode: FailureCode };
const reject = (failureCode: FailureCode): WagerDecision => ({ type: 'reject', failureCode });

export class WagerRules {
  static evaluate(tx: WagerTransaction, wallet: Wallet, reference?: WagerTransaction, alreadyReversed = false): WagerDecision {
    if (tx.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE', 'Transação terminal não pode ser reaplicada.');
    if (tx.walletId !== wallet.id || tx.playerId !== wallet.playerId) return reject('WALLET_MISMATCH');
    if (tx.money.currency !== wallet.currency) return reject('CURRENCY_MISMATCH');
    if (tx.requiresReference() || (tx.kind === 'WIN' && tx.referenceExternalTransactionId !== undefined)) {
      if (!reference) return { type: 'wait' };
      if (reference.externalTransactionId !== tx.referenceExternalTransactionId || reference.providerId !== tx.providerId ||
          reference.playerId !== tx.playerId || reference.walletId !== tx.walletId || reference.roundId !== tx.roundId ||
          reference.money.currency !== tx.money.currency) return reject('REFERENCE_MISMATCH');
      const allowedKinds = tx.kind === 'ROLLBACK' ? ['BET','WIN','REFUND'] : ['BET'];
      if (!allowedKinds.includes(reference.kind)) return reject('INVALID_REFERENCE_KIND');
      if (!reference.isTerminal()) return { type: 'wait' };
      if (reference.status !== 'PROCESSED') return reject('REFERENCE_NOT_PROCESSED');
      if (tx.requiresReference()) {
        if (!tx.money.equals(reference.money)) return reject('REFERENCE_AMOUNT_MISMATCH');
        if (alreadyReversed) return reject('REFERENCE_ALREADY_REVERSED');
      }
    }
    const direction = tx.ledgerDirectionFor(reference);
    if (direction === 'DEBIT' && wallet.balance.isLessThan(tx.money)) {
      return reject(tx.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS');
    }
    return { type: 'apply', direction };
  }
}

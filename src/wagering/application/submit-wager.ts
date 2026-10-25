import type { IdempotentUnitOfWork } from './idempotency';
import type { InboxContext } from '../../messaging/domain/inbox-message';
import type { Clock } from '../../shared/domain/clock';
import type { Identifiers } from '../../shared/domain/identifiers';
import type { ProcessingResponse } from './processing-result';
import type { FinancialSession } from '../../shared/application/unit-of-work';
import type { ProcessingResult } from './processing-result';
import { ApplicationError } from '../../shared/application/application-error';
import { isTransientFailure } from '../../shared/application/transient-failure';
import { canonicalPayload } from './canonical-payload';
import { Money } from '../../shared/domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { WagerRules } from '../domain/wager-rules';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged } from '../../messaging/domain/events';
import { noObservation, observe, observeContext, type Observation } from '../../shared/application/observation';

export interface SubmissionContext { idempotencyKey: string; correlationId: string; causationId?: string; inbox?: InboxContext; }
export class SubmitWager {
  async reprocessPending(id: string, owner: string, now?: () => Date): Promise<void> {
    if (!this.uow.runPending) throw new Error('Unidade de trabalho sem suporte a referências pendentes.');
    const started = performance.now();
    let transition: Record<string, unknown> | undefined;
    await this.uow.runPending(id, owner, now, async (tx, session, context, expired) => {
      observeContext(this.observation, { correlationId: context.correlationId,
        ...(context.causationId === undefined ? {} : { messageId: context.causationId }), transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId });
      const previous = tx.status;
      const result = await this.process(tx, session, context, expired);
      if (result.status !== previous) transition = { correlationId: context.correlationId, messageId: context.causationId,
        transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, kind: tx.kind, status: result.status, component: 'reference' };
      return result;
    });
    if (transition) observe(this.observation, 'transaction_committed', { ...transition, durationSeconds: (performance.now() - started) / 1000 });
  }
  constructor(private readonly uow: IdempotentUnitOfWork, private readonly clock: Clock, private readonly ids: Identifiers,
    private readonly sleep: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds),
    private readonly observation: Observation = noObservation) {}
  async execute(input: unknown, context: SubmissionContext): Promise<ProcessingResponse> {
    if (typeof context.idempotencyKey !== 'string' || !context.idempotencyKey.trim() || context.idempotencyKey.length > 320) {
      throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key é obrigatória e deve ter até 320 caracteres.', 400);
    }
    const { payload, hash } = canonicalPayload(input);
    const id = this.ids.next(), createdAt = this.clock.now(), started = performance.now();
    for (let attempt = 0; ; attempt++) {
      // A tentativa anterior pode ter alterado o domínio antes do rollback SQL.
      const transaction = WagerTransaction.create({ ...payload, money: Money.from(payload.money),
        id, idempotencyKey: context.idempotencyKey, payloadHash: hash, createdAt });
      try {
        const result = await this.uow.runIdempotent(transaction, session => this.process(transaction, session, context), {
          lockWallet: true, ...(context.inbox === undefined ? {} : { inbox: context.inbox }),
        });
        observe(this.observation, result.idempotentReplay ? 'duplicate' : 'transaction_committed', {
          correlationId: context.correlationId, messageId: context.inbox?.messageId, transactionId: result.transactionId,
          walletId: payload.walletId, providerId: payload.providerId, kind: payload.kind, status: result.status,
          component: 'submit', durationSeconds: (performance.now() - started) / 1000,
        });
        return result;
      } catch (error) {
        if (!isTransientFailure(error)) throw error;
        const metadata = { component: 'submit', correlationId: context.correlationId, transactionId: id, walletId: payload.walletId, providerId: payload.providerId };
        const code = (error as { code?: unknown }).code;
        if (['55P03', '40P01', '40001'].includes(String(code))) observe(this.observation, 'lock_conflict', metadata);
        if (attempt >= 2) throw new ApplicationError('PROCESSING_UNAVAILABLE', 'Processamento temporariamente indisponível. Tente novamente com a mesma chave.', 503);
        observe(this.observation, 'retry', metadata);
        await this.sleep(25 * 2 ** attempt);
      }
    }
  }
  /** Apenas após rollback de falha técnica permanente de uma operação já validada. */
  async recordPermanentFailure(input: unknown, context: SubmissionContext): Promise<ProcessingResponse> {
    const started = performance.now();
    if (typeof context.idempotencyKey !== 'string' || !context.idempotencyKey.trim() || context.idempotencyKey.length > 320) {
      throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key é obrigatória e deve ter até 320 caracteres.', 400);
    }
    const { payload, hash } = canonicalPayload(input);
    const transaction = WagerTransaction.create({ ...payload, money: Money.from(payload.money), id: this.ids.next(),
      idempotencyKey: context.idempotencyKey, payloadHash: hash, createdAt: this.clock.now() });
    const result = await this.uow.runIdempotent(transaction, async () => {
      transaction.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
      return { transactionId: transaction.id, status: transaction.status, failureCode: transaction.failureCode!, httpStatus: 500, terminal: true };
    }, { lockWallet: true, ...(context.inbox === undefined ? {} : { inbox: context.inbox }) });
    observe(this.observation, result.idempotentReplay ? 'duplicate' : 'transaction_committed', {
      correlationId: context.correlationId, messageId: context.inbox?.messageId, transactionId: result.transactionId,
      walletId: payload.walletId, providerId: payload.providerId, kind: payload.kind, status: result.status, component: 'submit',
      durationSeconds: (performance.now() - started) / 1000,
    });
    return result;
  }
  private async process(tx: WagerTransaction, session: FinancialSession, context: Pick<SubmissionContext, 'correlationId' | 'causationId'>, expired = false): Promise<ProcessingResult> {
    const wallet = await session.lockWallet(tx.walletId);
    const reference = tx.referenceExternalTransactionId === undefined ? undefined
      : await session.findReference(tx.providerId, tx.referenceExternalTransactionId);
    const alreadyReversed = tx.requiresReference() && reference !== undefined
      ? await session.hasCompletedReversal(reference.id) : false;
    const decision = expired ? { type: 'reject' as const, failureCode: 'REFERENCE_EXPIRED' as const } : WagerRules.evaluate(tx, wallet, reference, alreadyReversed);
    const occurredAt = this.clock.now();
    const eventContext = () => ({ eventId: this.ids.next(), correlationId: context.correlationId, occurredAt,
      ...(context.causationId === undefined ? {} : { causationId: context.causationId }) });
    if (decision.type === 'wait') {
      const initial = tx.status !== 'PENDING_REFERENCE';
      tx.markPendingReference();
      if (initial) await session.enqueue(WagerTransactionPendingReference.from(tx, eventContext()));
      return { transactionId: tx.id, status: tx.status, httpStatus: 202, terminal: false };
    }
    if (decision.type === 'reject') {
      tx.reject(decision.failureCode);
      await session.enqueue(WagerTransactionRejected.from(tx, eventContext()));
      return { transactionId: tx.id, status: tx.status, failureCode: decision.failureCode,
        balance: wallet.balance.toJSON(), httpStatus: 422, terminal: true };
    }
    if (decision.direction !== null) {
      const movement = { transactionId: tx.id, entryId: this.ids.next(), at: occurredAt };
      const entry = decision.direction === 'DEBIT' ? wallet.debit(tx.money, movement) : wallet.credit(tx.money, movement);
      await session.saveWallet(wallet);
      await session.insertLedger(entry);
      await session.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext()));
    }
    tx.markProcessed(reference?.id, occurredAt);
    await session.enqueue(WagerTransactionProcessed.from(tx, eventContext()));
    return { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(), httpStatus: 200, terminal: true };
  }
}

import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import type { UnitOfWork, FinancialSession } from '../shared/application/unit-of-work';
import { DomainError } from '../shared/domain/domain-error';
import { walletToRecord, walletFromRecord, wagerToRecord, wagerFromRecord, ledgerToRecord } from './mappers';
import { InboxRecord, OutboxRecord, WagerRecord, WalletRecord, type JsonValue } from './records';
import { InboxMessage } from '../messaging/domain/inbox-message';
import type { InboxContext } from '../messaging/domain/inbox-message';
import { ApplicationError } from '../shared/application/application-error';
import type { WagerTransaction } from '../wagering/domain/wager-transaction';
import { processingResponse, type ProcessingResult, type ProcessingResponse } from '../wagering/application/processing-result';
import { IdempotencyConflict, type IdempotentUnitOfWork, type IdempotentOptions } from '../wagering/application/idempotency';

export class PostgresUnitOfWork implements UnitOfWork, IdempotentUnitOfWork {
  async runPending(id: string, owner: string, now: (() => Date) | undefined, work: (transaction: WagerTransaction, session: FinancialSession,
    context: { correlationId: string; causationId?: string }, expired: boolean) => Promise<ProcessingResult>): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await em.execute("select set_config('lock_timeout', ?, true)", [`${this.options.lockTimeoutMs ?? 3000}ms`]);
      // Consulta sem lock: a seleção já foi confirmada. Nunca aguardar carteira segurando o lock da pendência.
      const candidate = await em.findOne(WagerRecord, { id });
      if (!candidate || candidate.status !== 'PENDING_REFERENCE') return;
      await this.lockWallet(em, candidate.walletId);
      const record = await em.findOneOrFail(WagerRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
      // Mesma autoridade temporal do claim em produção, medida depois da espera pelos locks.
      const checkedAt = now ? now() : new Date((await em.execute<{ now: Date }[]>('select statement_timestamp() as now'))[0]!.now);
      if (record.status !== 'PENDING_REFERENCE' || record.leaseOwner !== owner || record.leaseUntil === null || record.leaseUntil <= checkedAt) return;
      if (record.referenceDeadline === null) throw new Error('Pendência sem prazo persistido.');
      const pending = await em.findOneOrFail(OutboxRecord, { aggregateId: id, eventType: 'WagerTransactionPendingReference' });
      const payload = pending.payload as { correlationId?: unknown; causationId?: unknown };
      if (typeof payload.correlationId !== 'string' || payload.causationId !== undefined && typeof payload.causationId !== 'string') throw new Error('Contexto original inválido.');
      const tx = wagerFromRecord(record);
      const result = await work(tx, this.session(em), { correlationId: payload.correlationId,
        ...(typeof payload.causationId === 'string' ? { causationId: payload.causationId } : {}) }, record.referenceDeadline <= checkedAt);
      if (result.transactionId !== id || result.status !== tx.status || result.terminal !== tx.isTerminal()) throw new Error('Resultado incompatível com a transação.');
      wagerToRecord(tx, record);
      record.result = structuredClone(result) as unknown as JsonValue;
      if (tx.status === 'PENDING_REFERENCE') {
        record.nextAttemptAt = new Date(Math.min(record.referenceDeadline.getTime(), checkedAt.getTime() + Math.min(300000, 1000 * 2 ** Math.min(record.attempts, 9))));
        record.attempts++;
      } else record.nextAttemptAt = null;
      record.leaseOwner = null; record.leaseUntil = null;
      await em.flush();
      await this.options.beforePendingCommit?.();
    });
  }
  constructor(private readonly orm: MikroORM, private readonly options: { lockTimeoutMs?: number; afterInboxReserved?: () => Promise<void>; beforePendingCommit?: () => Promise<void> } = {}) {
    if (options.lockTimeoutMs !== undefined && (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 1 || options.lockTimeoutMs > 60000)) {
      throw new Error('lockTimeoutMs deve estar entre 1 e 60000.');
    }
  }
  async runIdempotent(transaction: WagerTransaction, work: (session: FinancialSession) => Promise<ProcessingResult>, options?: IdempotentOptions): Promise<ProcessingResponse> {
    try {
      return await this.attempt(transaction, work, options);
    } catch (error) {
      if (!isIdempotencyViolation(error)) throw error;
      // O contexto abortado foi descartado. A recuperação inclui a inbox na nova SQL.
      return this.attempt(transaction, work, options);
    }
  }
  private async attempt(transaction: WagerTransaction, work: (session: FinancialSession) => Promise<ProcessingResult>, options?: IdempotentOptions): Promise<ProcessingResponse> {
    return this.orm.em.fork().transactional(async em => {
      await em.execute("select set_config('lock_timeout', ?, true)", [`${this.options.lockTimeoutMs ?? 3000}ms`]);
      const inbox = options?.inbox === undefined ? undefined : await this.reserveInbox(em, options.inbox);
      const existing = await this.findIdentity(em, transaction);
      if (existing.length) {
        const response = this.replay(existing, transaction);
        if (inbox) await this.completeInbox(em, inbox);
        return response;
      }
      if (inbox !== undefined && inbox.processedAt !== null) throw new Error('Inbox concluída sem transação correspondente.');
      if (options?.lockWallet) {
        // Bloquear antes do INSERT evita promoção concorrente dos locks KEY SHARE da FK.
        await this.lockWallet(em, transaction.walletId);
      }
      const record = wagerToRecord(transaction);
      await em.persist(record).flush();
      const result = await work(this.session(em));
      if (result.transactionId !== transaction.id || result.status !== transaction.status || result.terminal !== transaction.isTerminal()) {
        throw new Error('Resultado incompatível com a transação.');
      }
      wagerToRecord(transaction, record);
      if (transaction.status === 'PENDING_REFERENCE') {
        record.referenceDeadline = new Date(transaction.createdAt.getTime() + 86400000);
        record.nextAttemptAt = new Date(transaction.createdAt.getTime() + 1000);
      }
      record.result = structuredClone(result) as unknown as JsonValue;
      if (inbox) await this.completeInbox(em, inbox);
      await em.flush();
      return processingResponse(result, false);
    });
  }
  private async reserveInbox(em: EntityManager, context: InboxContext): Promise<InboxRecord> {
    const message = InboxMessage.receive(context);
    // Serializa a identidade composta antes de locks de carteira; colisões de hash só reduzem concorrência.
    await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [JSON.stringify([message.consumerName, message.messageId])]);
    const existing = await em.findOne(InboxRecord, { consumerName: message.consumerName, messageId: message.messageId });
    if (existing) {
      InboxMessage.rehydrate(existing).assertSamePayload(message.payloadHash);
      return existing;
    }
    const record = Object.assign(new InboxRecord(), { consumerName: message.consumerName, messageId: message.messageId,
      payloadHash: message.payloadHash, receivedAt: message.receivedAt });
    await em.persist(record).flush();
    await this.options.afterInboxReserved?.();
    return record;
  }
  private async completeInbox(em: EntityManager, record: InboxRecord): Promise<void> {
    if (record.processedAt !== null) return;
    const message = InboxMessage.rehydrate(record).complete(new Date(Math.max(Date.now(), record.receivedAt.getTime())));
    record.processedAt = message.processedAt;
    await em.flush();
  }
  private findIdentity(em: EntityManager, transaction: WagerTransaction): Promise<WagerRecord[]> {
    return em.find(WagerRecord, { $or: [
      { idempotencyKey: transaction.idempotencyKey },
      { providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId },
    ] });
  }
  private replay(rows: WagerRecord[], transaction: WagerTransaction): ProcessingResponse {
    const record = rows[0]!;
    if (rows.length !== 1 || record.idempotencyKey !== transaction.idempotencyKey || record.providerId !== transaction.providerId || record.externalTransactionId !== transaction.externalTransactionId) {
      throw new IdempotencyConflict('IDEMPOTENCY_IDENTITY_CONFLICT');
    }
    if (record.payloadHash !== transaction.payloadHash) throw new IdempotencyConflict('IDEMPOTENCY_PAYLOAD_CONFLICT');
    if (record.result === null) throw new Error('Transação persistida sem resultado de processamento.');
    return processingResponse(record.result as unknown as ProcessingResult, true);
  }
  private session(em: EntityManager): FinancialSession {
    return {
      findReference: async (providerId, externalTransactionId) => {
        const record = await em.findOne(WagerRecord, { providerId, externalTransactionId });
        return record === null ? undefined : wagerFromRecord(record);
      },
      hasCompletedReversal: async referenceTransactionId => (await em.count(WagerRecord, {
        referenceTransactionId, kind: { $in: ['REFUND', 'ROLLBACK'] }, status: 'PROCESSED',
      })) > 0,
      lockWallet: async id => walletFromRecord(await this.lockWallet(em, id)),
      saveWallet: async wallet => {
        const record = await em.findOneOrFail(WalletRecord, { id: wallet.id });
        walletToRecord(wallet, record); await em.flush();
      },
      insertWallet: async wallet => { await em.persist(walletToRecord(wallet)).flush(); },
      insertWager: async transaction => { await em.persist(wagerToRecord(transaction)).flush(); },
      insertLedger: async entry => { await em.persist(ledgerToRecord(entry)).flush(); },
      enqueue: async event => {
        const record = Object.assign(new OutboxRecord(), {
          id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
          occurredAt: event.occurredAt, payload: event.toJSON() as JsonValue,
        });
        await em.persist(record).flush();
      },
    };
  }
  private lockWallet(em: EntityManager, id: string): Promise<WalletRecord> {
    return em.findOneOrFail(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE,
      failHandler: () => new ApplicationError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404) });
  }
  async run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async em => work(this.session(em)));
    } catch (error) {
      if (error === null || typeof error !== 'object') throw error;
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code === '23505' && databaseError.constraint === 'wallet_player_currency_uq') {
        throw new DomainError('WALLET_ALREADY_EXISTS', 'Já existe uma carteira para este jogador e esta moeda.');
      }
      throw error;
    }
  }
}

function isIdempotencyViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && (candidate.constraint === 'wager_idempotency_uq' || candidate.constraint === 'wager_provider_external_uq' || candidate.constraint === 'inbox_message_pkey');
}

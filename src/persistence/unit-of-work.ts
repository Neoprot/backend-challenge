import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import type { UnitOfWork, FinancialSession } from '../shared/application/unit-of-work';
import { DomainError } from '../shared/domain/domain-error';
import { walletToRecord, walletFromRecord, wagerToRecord, wagerFromRecord, ledgerToRecord } from './mappers';
import { OutboxRecord, WagerRecord, WalletRecord, type JsonValue } from './records';
import { ApplicationError } from '../shared/application/application-error';
import type { WagerTransaction } from '../wagering/domain/wager-transaction';
import { processingResponse, type ProcessingResult, type ProcessingResponse } from '../wagering/application/processing-result';
import { IdempotencyConflict, type IdempotentUnitOfWork } from '../wagering/application/idempotency';

export class PostgresUnitOfWork implements UnitOfWork, IdempotentUnitOfWork {
  constructor(private readonly orm: MikroORM, private readonly options: { lockTimeoutMs?: number } = {}) {
    if (options.lockTimeoutMs !== undefined && (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 1 || options.lockTimeoutMs > 60000)) {
      throw new Error('lockTimeoutMs deve estar entre 1 e 60000.');
    }
  }
  async runIdempotent(transaction: WagerTransaction, work: (session: FinancialSession) => Promise<ProcessingResult>, options?: { lockWallet: boolean }): Promise<ProcessingResponse> {
    try {
      return await this.orm.em.fork().transactional(async em => {
        const existing = await this.findIdentity(em, transaction);
        if (existing.length) return this.replay(existing, transaction);
        if (options?.lockWallet) {
          await em.execute("select set_config('lock_timeout', ?, true)", [`${this.options.lockTimeoutMs ?? 3000}ms`]);
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
        await em.flush();
        return processingResponse(result, false);
      });
    } catch (error) {
      if (!isIdempotencyViolation(error)) throw error;
      // A transação anterior já foi desfeita. Nunca consultar seu contexto abortado.
      const rows = await this.findIdentity(this.orm.em.fork(), transaction);
      if (!rows.length) throw error;
      return this.replay(rows, transaction);
    }
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
  return candidate.code === '23505' && (candidate.constraint === 'wager_idempotency_uq' || candidate.constraint === 'wager_provider_external_uq');
}

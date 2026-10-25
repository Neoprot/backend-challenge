import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import type { UnitOfWork, FinancialSession } from '../shared/application/unit-of-work';
import { DomainError } from '../shared/domain/domain-error';
import { walletToRecord, wagerToRecord, ledgerToRecord } from './mappers';
import { OutboxRecord, WagerRecord, type JsonValue } from './records';
import type { WagerTransaction } from '../wagering/domain/wager-transaction';
import { processingResponse, type ProcessingResult, type ProcessingResponse } from '../wagering/application/processing-result';
import { IdempotencyConflict, type IdempotentUnitOfWork } from '../wagering/application/idempotency';

export class PostgresUnitOfWork implements UnitOfWork, IdempotentUnitOfWork {
  constructor(private readonly orm: MikroORM) {}
  async runIdempotent(transaction: WagerTransaction, work: (session: FinancialSession) => Promise<ProcessingResult>): Promise<ProcessingResponse> {
    try {
      return await this.orm.em.fork().transactional(async em => {
        const existing = await this.findIdentity(em, transaction);
        if (existing.length) return this.replay(existing, transaction);
        const record = wagerToRecord(transaction);
        await em.persist(record).flush();
        const result = await work(this.session(em));
        if (result.transactionId !== transaction.id || result.status !== transaction.status || result.terminal !== transaction.isTerminal()) {
          throw new Error('Resultado incompatível com a transação.');
        }
        wagerToRecord(transaction, record);
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

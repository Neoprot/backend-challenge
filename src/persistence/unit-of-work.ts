import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork, FinancialSession } from '../shared/application/unit-of-work';
import { DomainError } from '../shared/domain/domain-error';
import { walletToRecord, wagerToRecord, ledgerToRecord } from './mappers';
import { OutboxRecord, type JsonValue } from './records';

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}
  async run<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async em => work({
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
      }));
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

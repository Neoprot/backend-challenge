import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from '../identity/auth.guard';
import { KeycloakVerifier } from '../identity/keycloak-verifier';
import { Module, type DynamicModule } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Configuration } from './config';
import { CONFIGURATION, ORM, SQS, UNIT_OF_WORK, WALLET_QUERIES, TRANSACTION_QUERIES, CLOCK, IDENTIFIERS } from './tokens';
import { PostgresUnitOfWork } from '../persistence/unit-of-work';
import { PostgresWalletQueries } from '../persistence/wallet-queries';
import { PostgresTransactionQueries } from '../persistence/transaction-queries';
import { SystemClock, type Clock } from '../shared/domain/clock';
import { UuidIdentifiers, type Identifiers } from '../shared/domain/identifiers';
import { OpenWallet } from '../wallets/application/open-wallet';
import { ReadWallet } from '../wallets/application/read-wallet';
import { ListLedger } from '../wallets/application/list-ledger';
import { ReconcileWallet } from '../wallets/application/reconcile-wallet';
import { SubmitWager } from '../wagering/application/submit-wager';
import { ReadTransaction, type TransactionQueries } from '../wagering/application/read-transaction';
import type { WalletQueries } from '../wallets/application/wallet-queries';
import { WalletsController } from '../http/wallets.controller';
import { WageringController } from '../http/wagering.controller';
import { HealthController, Readiness } from '../http/health.controller';

export interface ApplicationOptions { lockTimeoutMs?: number; clock?: Clock; }
@Module({})
export class AppModule {
  static register(configuration: Configuration, orm: MikroORM, sqs: SQSClient, options: ApplicationOptions): DynamicModule {
    return { module: AppModule, controllers: [WalletsController, WageringController, HealthController], providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: KeycloakVerifier, inject: [CLOCK], useFactory: (clock: Clock) => new KeycloakVerifier(configuration, clock) },
      { provide: CONFIGURATION, useValue: configuration }, { provide: ORM, useValue: orm }, { provide: SQS, useValue: sqs },
      { provide: CLOCK, useFactory: () => options.clock ?? new SystemClock() }, { provide: IDENTIFIERS, useFactory: () => new UuidIdentifiers() },
      { provide: UNIT_OF_WORK, inject: [ORM], useFactory: (db: MikroORM) => new PostgresUnitOfWork(db, options) },
      { provide: WALLET_QUERIES, inject: [ORM], useFactory: (db: MikroORM) => new PostgresWalletQueries(db) },
      { provide: TRANSACTION_QUERIES, inject: [ORM], useFactory: (db: MikroORM) => new PostgresTransactionQueries(db) },
      { provide: OpenWallet, inject: [UNIT_OF_WORK, CLOCK, IDENTIFIERS],
        useFactory: (uow: PostgresUnitOfWork, clock: Clock, ids: Identifiers) => new OpenWallet(uow, clock, ids) },
      { provide: SubmitWager, inject: [UNIT_OF_WORK, CLOCK, IDENTIFIERS],
        useFactory: (uow: PostgresUnitOfWork, clock: Clock, ids: Identifiers) => new SubmitWager(uow, clock, ids) },
      { provide: ReadWallet, inject: [WALLET_QUERIES], useFactory: (queries: WalletQueries) => new ReadWallet(queries) },
      { provide: ListLedger, inject: [WALLET_QUERIES], useFactory: (queries: WalletQueries) => new ListLedger(queries) },
      { provide: ReconcileWallet, inject: [WALLET_QUERIES], useFactory: (queries: WalletQueries) => new ReconcileWallet(queries) },
      { provide: ReadTransaction, inject: [TRANSACTION_QUERIES], useFactory: (queries: TransactionQueries) => new ReadTransaction(queries) },
      { provide: Readiness, inject: [ORM, SQS], useFactory: (db: MikroORM, client: SQSClient) => new Readiness(db, client) },
      { provide: 'resource-cleanup', useValue: { onApplicationShutdown: async () => { sqs.destroy(); await orm.close(true); } } },
    ] };
  }
}

import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { Configuration } from '@mikro-orm/core';
import { isConnectionLostFailure } from '../shared/application/transient-failure';

export async function releaseAfterDisconnectedRollback(rollback: () => Promise<void>): Promise<void> {
  try { await rollback(); }
  catch (error) { if (!isConnectionLostFailure(error)) throw error; }
}
export class RecoveringPostgreSqlDriver extends PostgreSqlDriver {
  constructor(configuration: Configuration) {
    super(configuration);
    for (const connection of [this.connection, ...this.replicas]) {
      const createDialect = connection.createKyselyDialect.bind(connection);
      connection.createKyselyDialect = overrides => {
        const dialect = createDialect(overrides), createDriver = dialect.createDriver.bind(dialect);
        dialect.createDriver = () => {
          const driver = createDriver(), rollback = driver.rollbackTransaction.bind(driver);
          // MikroORM 7.2.5 usa ControlledTransaction: Kysely só libera o checkout após
          // rollback resolver. A conexão perdida já abortou a SQL no PostgreSQL;
          // permitir esse release evita vazamento sem alterar o erro ORIGINAL do callback.
          driver.rollbackTransaction = (...args) => releaseAfterDisconnectedRollback(() => rollback(...args));
          return driver;
        };
        return dialect;
      };
    }
  }
}

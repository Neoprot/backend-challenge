import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration202610240001 } from './migrations/Migration202610240001';
import { Migration202610240002 } from './migrations/Migration202610240002';
import { persistenceSchemas } from './schemas';
import { RecoveringPostgreSqlDriver } from './recovering-postgres-driver';

export function createOrm(clientUrl: string) {
  return MikroORM.init({ driver: RecoveringPostgreSqlDriver, clientUrl, entities: persistenceSchemas,
    driverOptions: { connectionTimeoutMillis: 1000 }, logger: () => {},
    extensions: [Migrator], migrations: { snapshot: false, migrationsList: [Migration202610240001, Migration202610240002] } });
}

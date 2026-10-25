import { createOrm } from '../src/persistence/orm';

const action = process.argv[2];
if (action !== 'up' && action !== 'down') {
  console.error('Ação inválida: utilize up ou down.');
  process.exit(1);
}
const clientUrl = process.env.MIGRATION_DATABASE_URL;
if (!clientUrl?.trim()) {
  console.error('MIGRATION_DATABASE_URL obrigatória.');
  process.exit(1);
}
let orm: Awaited<ReturnType<typeof createOrm>> | undefined;
try {
  orm = await createOrm(clientUrl);
  const migrations = action === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(JSON.stringify({ action, migrations: migrations.map(migration => migration.name) }));
} catch {
  console.error('Falha na migration. Verifique conectividade, permissões e estado das migrations no banco configurado.');
  process.exitCode = 1;
} finally {
  await orm?.close(true);
}

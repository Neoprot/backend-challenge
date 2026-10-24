export function testEnvironment(environment: Record<string, string | undefined> = process.env) {
  const databaseUrl = environment.TEST_DATABASE_URL ?? 'postgresql://wager_app:local-app-only@127.0.0.1:55433/wagering_test';
  const migrationDatabaseUrl = environment.TEST_MIGRATION_DATABASE_URL ?? 'postgresql://wager_migrator:local-migrator-only@127.0.0.1:55433/wagering_test';
  const sqsEndpoint = environment.TEST_SQS_ENDPOINT ?? 'http://127.0.0.1:4567';
  const issuer = environment.TEST_OIDC_ISSUER ?? 'http://localhost:8181/realms/wagering';
  for (const value of [databaseUrl, migrationDatabaseUrl, sqsEndpoint, issuer]) {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('IT exige serviços locais isolados');
    }
  }
  for (const value of [databaseUrl, migrationDatabaseUrl]) {
    const url = new URL(value);
    if (url.pathname !== '/wagering_test' || url.port !== '55433') {
      throw new Error('IT exige banco wagering_test na porta 55433');
    }
  }
  if (new URL(sqsEndpoint).port !== '4567' || new URL(issuer).port !== '8181') {
    throw new Error('IT exige portas SQS 4567 e Keycloak 8181');
  }
  return { databaseUrl, migrationDatabaseUrl, sqsEndpoint, issuer };
}

import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { testEnvironment } from '../support/environment';

const { databaseUrl, sqsEndpoint: endpoint, issuer } = testEnvironment();

test('PostgreSQL real responde com role restrita e banco exclusivo de teste', async () => {
  expect(new URL(databaseUrl).pathname).toBe('/wagering_test');
  const orm = await MikroORM.init({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });
  try {
    const result = await orm.em.getConnection().execute<{ ok: number; rolsuper: boolean; rolcreatedb: boolean }[]>(
      'select 1 as ok, rolsuper, rolcreatedb from pg_roles where rolname = current_user',
    );
    expect(result).toEqual([{ ok: 1, rolsuper: false, rolcreatedb: false }]);
  } finally {
    await orm.close(true);
  }
});

test('SQS real possui filas FIFO com redrive após cinco recebimentos', async () => {
  const client = new SQSClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  try {
    for (const name of ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo']) {
      const queue = await client.send(new GetQueueUrlCommand({ QueueName: name }));
      expect(queue.QueueUrl).toBeString();
      const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl!, AttributeNames: ['All'] }));
      expect(attributes.Attributes?.FifoQueue).toBe('true');
      if (name === 'wager-transactions.fifo') {
        expect(JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}')).toMatchObject({ maxReceiveCount: 5 });
      }
    }
  } finally {
    client.destroy();
  }
});

test('Keycloak real publica descoberta OIDC e emite access token de serviço', async () => {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  expect(response.status).toBe(200);
  const document = await response.json() as { issuer: string; token_endpoint: string; jwks_uri: string };
  expect(document.issuer).toBe(issuer);
  expect(document.jwks_uri).toBe(`${issuer}/protocol/openid-connect/certs`);
  const token = await fetch(document.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'provider-aurora', client_secret: 'local-aurora-only' }),
    signal: AbortSignal.timeout(10000),
  });
  expect(token.status).toBe(200);
  const body = await token.json() as { access_token: string; token_type: string };
  expect(body.token_type).toBe('Bearer');
  expect(body.access_token.split('.')).toHaveLength(3);
});

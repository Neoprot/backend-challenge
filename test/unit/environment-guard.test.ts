import { expect, test } from 'bun:test';
import { testEnvironment } from '../support/environment';

test('harness recusa banco de desenvolvimento e serviços remotos', () => {
  expect(() => testEnvironment({ TEST_DATABASE_URL: 'postgresql://user:secret@localhost:5432/wagering' })).toThrow();
  expect(() => testEnvironment({ TEST_SQS_ENDPOINT: 'https://sqs.us-east-1.amazonaws.com' })).toThrow();
  expect(() => testEnvironment({ TEST_OIDC_ISSUER: 'https://example.org/realms/wagering' })).toThrow();
});

test('harness usa destinos locais exclusivos por padrão', () => {
  const config = testEnvironment({});
  expect(new URL(config.databaseUrl).pathname).toBe('/wagering_test');
  expect(new URL(config.sqsEndpoint).port).toBe('4567');
  expect(new URL(config.issuer).port).toBe('8181');
});

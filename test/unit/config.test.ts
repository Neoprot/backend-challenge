import { expect, test } from 'bun:test';
import { readConfiguration } from '../../src/bootstrap/config';

const valid = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/wagering',
  SQS_ENDPOINT: 'http://localhost:4566',
  OIDC_ISSUER: 'http://localhost:8180/realms/wagering',
  OIDC_AUDIENCE: 'wagering-api',
};

test('configuração exige banco e identidade sem vazar credenciais', () => {
  expect(() => readConfiguration({})).toThrow('DATABASE_URL');
  expect(() => readConfiguration({ ...valid, DATABASE_URL: 'secret-invalid-url' })).toThrow('DATABASE_URL inválida');
});

test('configuração rejeita portas inválidas', () => {
  for (const port of ['0', '65536', '1.5', 'NaN']) {
    expect(() => readConfiguration({ ...valid, PORT: port })).toThrow('PORT inválida');
  }
});

test('configuração aplica padrões explícitos', () => {
  expect(readConfiguration(valid)).toMatchObject({ port: 3000, region: 'us-east-1', audience: 'wagering-api' });
});
test('configuração permite JWKS explicitamente confiável e valida protocolo', () => {
  expect(readConfiguration({ ...valid, OIDC_JWKS_URI: 'http://keycloak:8080/realms/wagering/protocol/openid-connect/certs' })).toHaveProperty('jwksUri', 'http://keycloak:8080/realms/wagering/protocol/openid-connect/certs');
  expect(() => readConfiguration({ ...valid, OIDC_JWKS_URI: 'file:///keys' })).toThrow('OIDC_JWKS_URI');
});

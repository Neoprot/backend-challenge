import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap/main';
import { testEnvironment } from '../support/environment';
import { accessToken } from '../support/identity';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { KeycloakVerifier } from '../../src/identity/keycloak-verifier';
import { keycloakAdmin } from '../support/keycloak-admin';
import { createOrm } from '../../src/persistence/orm';
import { assertLedger } from '../support/assert-ledger';
const configuration = { ...testEnvironment(), audience: 'wagering-api', port: 3000, region: 'us-east-1' };
let app: INestApplication, base: string, provider: string, admin: string;
beforeAll(async () => {
  const migrator = await createOrm(configuration.migrationDatabaseUrl);
  try { await migrator.migrator.up(); } finally { await migrator.close(true); }
  provider = await accessToken(); admin = await accessToken('admin');
  app = await createApplication(configuration); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
const call = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
test('health público e autenticação obrigatória em recursos', async () => {
  expect((await call('/health/live')).status).toBe(200);
  expect((await call('/health/ready')).status).toBe(200);
  expect((await call('/wallets/' + crypto.randomUUID())).status).toBe(401);
});
test('token real de provedor não concede administração e admin consulta global', async () => {
  const id = crypto.randomUUID();
  expect((await call('/wallets/' + id, provider)).status).toBe(403);
  expect((await call('/wallets/' + id, admin)).status).toBe(404);
});
test('assinatura alterada e bearer inválido retornam 401', async () => {
  const [header, payload, signature] = provider.split('.');
  const tampered = header + '.' + payload + '.' + (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1);
  expect((await call('/wallets/' + crypto.randomUUID(), tampered)).status).toBe(401);
  expect((await call('/wallets/' + crypto.randomUUID(), 'invalid')).status).toBe(401);
});
test('provedor não consulta rota de outro provedor', async () => {
  expect((await call('/providers/horizonte/wagering/transactions/missing', provider)).status).toBe(403);
});



test.each(['issuer', 'audience', 'expired'] as const)('token real com %s inválido retorna 401 no endpoint', async condition => {
  const altered = condition === 'issuer' ? { issuer: configuration.issuer + '-wrong' } :
    condition === 'audience' ? { audience: 'another-api' } : {};
  const date = new Date((decodeJwt(provider).exp! + 1) * 1000);
  const other = await createApplication({ ...configuration, ...altered,
    jwksUri: configuration.issuer + '/protocol/openid-connect/certs' },
    condition === 'expired' ? { clock: { now: () => date } } : {});
  try {
    await other.listen(0, '127.0.0.1');
    const response = await fetch(await other.getUrl() + '/wallets/' + crypto.randomUUID(),
      { headers: { authorization: 'Bearer ' + provider } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  } finally { await other.close(); }
});

test('identidade de provedor vem do IdP e consulta interna não vaza outro provedor', async () => {
  const requested = await accessToken('aurora', { providerId: 'horizonte' });
  expect(decodeJwt(requested).providerId).toBe('aurora');
  const horizonte = await accessToken('horizonte');
  const playerId = crypto.randomUUID();
  const headers = (token: string) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
  const opened = await fetch(base + '/wallets', { method: 'POST', headers: headers(admin),
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }) });
  expect(opened.status).toBe(201);
  const { id: walletId } = await opened.json() as { id: string };
  const command = { providerId: 'aurora', externalTransactionId: crypto.randomUUID(), playerId, walletId,
    roundId: 'identity-round', gameId: 'identity-game', kind: 'BET', money: { amount: '5.00', currency: 'BRL' } };
  const submit = (token: string, providerId = 'aurora') => fetch(base + '/wagering/transactions', {
    method: 'POST', headers: { ...headers(token), 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ ...command, providerId }),
  });
  expect((await submit(provider, 'horizonte')).status).toBe(403);
  expect((await submit(admin)).status).toBe(403);
  const accepted = await submit(provider);
  expect(accepted.status).toBe(200);
  const { transactionId } = await accepted.json() as { transactionId: string };
  const forbidden = await call('/wagering/transactions/' + transactionId, horizonte);
  expect(forbidden.status).toBe(403);
  const denied = await forbidden.json() as Record<string, unknown>;
  expect(denied).toMatchObject({ code: 'FORBIDDEN' });
  expect(denied).not.toHaveProperty('providerId'); expect(denied).not.toHaveProperty('result');
  expect((await call('/wagering/transactions/' + transactionId, provider)).status).toBe(200);
  expect((await call('/wagering/transactions/' + transactionId, admin)).status).toBe(200);
  const orm = await createOrm(configuration.databaseUrl);
  try { await assertLedger(orm, walletId); } finally { await orm.close(true); }
});

test('access token real sem papel de aplicação autentica mas recebe 403', async () => {
  const adminRequest = await keycloakAdmin();
  const clientId = 'identity-no-role-' + crypto.randomUUID();
  let resource: string | undefined;
  try {
    // Modelo existente é consultado antes da mutação temporária.
    const existing = await adminRequest('/clients?clientId=provider-aurora');
    expect(existing.status).toBe(200);
    const models = await existing.json() as { protocolMappers: { id?: string; name: string; protocol: string; protocolMapper: string; config: Record<string, string> }[] }[];
    expect(models).toHaveLength(1);
    const created = await adminRequest('/clients', 'POST', {
      clientId, publicClient: false, secret: 'local-identity-test-only', serviceAccountsEnabled: true,
      standardFlowEnabled: false, directAccessGrantsEnabled: false, protocol: 'openid-connect',
      protocolMappers: models[0]!.protocolMappers.filter(mapper => mapper.name === 'api-audience').map(({ id: _id, ...mapper }) => mapper),
    });
    expect(created.status).toBe(201);
    resource = '/clients/' + created.headers.get('location')!.split('/').at(-1)!;
    const tokenResponse = await fetch(configuration.issuer + '/protocol/openid-connect/token', { method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: 'local-identity-test-only' }) });
    expect(tokenResponse.status).toBe(200);
    const { access_token } = await tokenResponse.json() as { access_token: string };
    expect((await call('/wallets/' + crypto.randomUUID(), access_token)).status).toBe(403);
    expect((await call('/providers/aurora/wagering/transactions/missing', access_token)).status).toBe(403);
  } finally {
    if (resource) expect((await adminRequest(resource, 'DELETE')).status).toBe(204);
  }
});

test('rotação RSA real atualiza JWKS cacheado; falha de rede na chave nova resulta 503', async () => {
  const adminRequest = await keycloakAdmin();
  const oldToken = await accessToken();
  const verifier = new KeycloakVerifier(configuration, undefined, 0);
  await verifier.verify('Bearer ' + oldToken);
  // Proxy de falha repassa o JWKS real e depois encerra sua porta, sem substituir o IdP.
  let jwksFailure: number | undefined;
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => jwksFailure === undefined
    ? fetch(configuration.issuer + '/protocol/openid-connect/certs')
    : new Response(jwksFailure === 204 ? null : 'not-json', { status: jwksFailure }) });
  const unavailable = new KeycloakVerifier({ ...configuration, jwksUri: proxy.url.href }, undefined, 0);
  let component: string | undefined;
  let dependentApp: INestApplication | undefined;
  try {
    await unavailable.verify('Bearer ' + oldToken);
    dependentApp = await createApplication({ ...configuration, jwksUri: proxy.url.href });
    await dependentApp.listen(0, '127.0.0.1');
    const dependentBase = await dependentApp.getUrl();
    expect((await fetch(dependentBase + '/wallets/' + crypto.randomUUID(),
      { headers: { authorization: 'Bearer ' + oldToken } })).status).toBe(403);
    const realmResponse = await adminRequest('');
    expect(realmResponse.status).toBe(200);
    const realm = await realmResponse.json() as { id: string };
    const componentsResponse = await adminRequest('/components?type=org.keycloak.keys.KeyProvider');
    expect(componentsResponse.status).toBe(200);
    const components = await componentsResponse.json() as { config?: { priority?: string[] } }[];
    const priority = Math.max(100, ...components.map(value => Number(value.config?.priority?.[0] ?? 0))) + 1;
    const created = await adminRequest('/components', 'POST', { name: 'identity-rotation-' + crypto.randomUUID(),
      parentId: realm.id, providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider',
      config: { priority: [String(priority)], enabled: ['true'], active: ['true'], keySize: ['2048'], algorithm: ['RS256'] } });
    expect(created.status).toBe(201);
    component = '/components/' + created.headers.get('location')!.split('/').at(-1)!;
    const rotated = await accessToken();
    expect(decodeProtectedHeader(rotated).kid).not.toBe(decodeProtectedHeader(oldToken).kid);
    expect((await verifier.verify('Bearer ' + rotated)).providerId).toBe('aurora');
    expect((await verifier.verify('Bearer ' + oldToken)).providerId).toBe('aurora');
    // O cache do guard usa cooldown explícito de 5 s para limitar buscas por kids desconhecidos.
    await Bun.sleep(5100);
    expect((await call('/wallets/' + crypto.randomUUID(), rotated)).status).toBe(403);
    for (const status of [200, 201, 204]) {
      jwksFailure = status;
      const failed = await fetch(dependentBase + '/wallets/' + crypto.randomUUID(),
        { headers: { authorization: 'Bearer ' + rotated } });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ code: 'DEPENDENCIES_UNAVAILABLE' });
    }
    await proxy.stop(true);
    await expect(unavailable.verify('Bearer ' + rotated)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const [header, payload, signature] = rotated.split('.');
    const unknown = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(header!, 'base64url').toString()), kid: crypto.randomUUID(),
      jku: 'http://127.0.0.1:1/untrusted' })).toString('base64url') + '.' + payload + '.' + signature;
    await expect(verifier.verify('Bearer ' + unknown)).rejects.toBeInstanceOf(UnauthorizedException);
  } finally {
    await dependentApp?.close();
    await proxy.stop(true);
    if (component) expect((await adminRequest(component, 'DELETE')).status).toBe(204);
  }
});


test('indisponibilidade real do endpoint JWKS é 503 sanitizado no HTTP', async () => {
  const unavailable = await createApplication({ ...configuration, jwksUri: 'http://127.0.0.1:1/unavailable' });
  try {
    await unavailable.listen(0, '127.0.0.1');
    const token = await accessToken();
    const response = await fetch(await unavailable.getUrl() + '/wallets/' + crypto.randomUUID(), { headers: { authorization: 'Bearer ' + token } });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'DEPENDENCIES_UNAVAILABLE' });
    expect(JSON.stringify(body)).not.toContain('127.0.0.1');
  } finally { await unavailable.close(); }
});

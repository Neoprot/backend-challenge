import { expect, test } from 'bun:test';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { principalFromClaims, KeycloakVerifier } from '../../src/identity/keycloak-verifier';
import { ProviderPolicy } from '../../src/identity/provider-policy';
import { beforeAll, afterAll } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
const claims = { sub: 'service-account', typ: 'Bearer', providerId: 'aurora', realm_access: { roles: ['wagering-provider'] } };
test('extração aceita somente identidade e papéis válidos e imutáveis', () => {
  const principal = principalFromClaims(claims);
  expect(principal).toEqual({ subject: 'service-account', providerId: 'aurora', roles: ['wagering-provider'] });
  expect(Object.isFrozen(principal)).toBe(true); expect(Object.isFrozen(principal.roles)).toBe(true);
});
test.each([{ ...claims, sub: '' }, { ...claims, sub: 1 }, { ...claims, typ: 'ID' },
  { ...claims, providerId: 12 }, { ...claims, providerId: '' }, { ...claims, providerId: 'a'.repeat(121) },
  { ...claims, realm_access: null }, { ...claims, realm_access: { roles: [1] } }, { ...claims, realm_access: [] },
  { ...claims, realm_access: { roles: 'wagering-provider' } }])('claims malformadas são 401 %#', value => {
  expect(() => principalFromClaims(value as never)).toThrow(UnauthorizedException);
});
test('ausência de papel é identidade válida mas política nega acesso e novas rotas', () => {
  const principal = principalFromClaims({ sub: 'valid', typ: 'Bearer' });
  expect(principal.roles).toEqual([]);
  expect(() => new ProviderPolicy().authorize(principal, undefined)).toThrow();
});
test.each([undefined, ['Bearer a.b.c'], 'Basic a.b.c', 'Bearer a.b', 'Bearer a.b.c extra', 'Bearer ' + 'a'.repeat(16385)])
  ('bearer malformado é recusado antes de qualquer rede %#', async value => {
  const verifier = new KeycloakVerifier({ issuer: 'http://127.0.0.1:1/realms/test', audience: 'api' });
  await expect(verifier.verify(value)).rejects.toBeInstanceOf(UnauthorizedException);
});


let signingKey: CryptoKey;
let keyServer: ReturnType<typeof Bun.serve>;
let signedVerifier: KeycloakVerifier;
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  const key = { ...await exportJWK(publicKey), kid: 'unit-test-key', alg: 'RS256', use: 'sig' };
  keyServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [key] }) });
  signedVerifier = new KeycloakVerifier({ issuer: 'https://unit.invalid/realm', audience: 'api', jwksUri: keyServer.url.href });
});
afterAll(async () => { await keyServer?.stop(true); });
const standard = () => ({ iss: 'https://unit.invalid/realm', aud: 'api', sub: 'unit-subject', typ: 'Bearer', exp: Math.floor(Date.now() / 1000) + 60 });
async function signed(payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'unit-test-key', ...header }).sign(signingKey);
}
test.each(['exp', 'sub', 'aud', 'iss', 'typ'])('assinatura válida não dispensa claim %s obrigatória', async missing => {
  const payload: Record<string, unknown> = standard(); delete payload[missing];
  await expect(signedVerifier.verify('Bearer ' + await signed(payload))).rejects.toBeInstanceOf(UnauthorizedException);
});
test('ID token assinado é recusado e header jku não escolhe chave', async () => {
  await expect(signedVerifier.verify('Bearer ' + await signed({ ...standard(), typ: 'ID' }))).rejects.toBeInstanceOf(UnauthorizedException);
  const token = await signed(standard(), { jku: 'http://127.0.0.1:1/attacker-jwks' });
  expect((await signedVerifier.verify('Bearer ' + token)).subject).toBe('unit-subject');
});
test('algoritmo não permitido é recusado independentemente do kid', async () => {
  const token = await new SignJWT(standard()).setProtectedHeader({ alg: 'HS256', kid: 'unit-test-key' }).sign(new Uint8Array(32));
  await expect(signedVerifier.verify('Bearer ' + token)).rejects.toBeInstanceOf(UnauthorizedException);
});

test.each([
  { status: 200, body: 'not-json' },
  { status: 201, body: '{"keys":[]}' },
  { status: 204, body: null },
  { status: 200, body: '{"keys":"invalid"}' },
])('falha da dependência JWKS status $status corpo $body retorna 503', async fixture => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response(fixture.body, { status: fixture.status }) });
  try {
    const verifier = new KeycloakVerifier({ issuer: 'https://unit.invalid/realm', audience: 'api', jwksUri: server.url.href });
    await expect(verifier.verify('Bearer ' + await signed(standard()))).rejects.toBeInstanceOf(ServiceUnavailableException);
  } finally { await server.stop(true); }
});

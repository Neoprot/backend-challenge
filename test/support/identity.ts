import { testEnvironment } from './environment';
export type TestClient = 'aurora' | 'horizonte' | 'admin';
// Credenciais exclusivas do realm local de testes.
export async function accessToken(client: TestClient = 'aurora', extra: Record<string, string> = {}): Promise<string> {
  const clients = { aurora: ['provider-aurora', 'local-aurora-only'], horizonte: ['provider-horizonte', 'local-horizonte-only'], admin: ['operations-console', 'local-operations-only'] } as const;
  const [clientId, secret] = clients[client];
  const response = await fetch(testEnvironment().issuer + '/protocol/openid-connect/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, ...extra }),
  });
  if (!response.ok) throw new Error('Keycloak local não emitiu access token: ' + response.status);
  const result = await response.json() as { access_token: string };
  return result.access_token;
}


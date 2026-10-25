import { testEnvironment } from './environment';
// Administração exclusivamente do Keycloak local isolado; tokens ficam em memória.
export async function keycloakAdmin() {
  const origin = new URL(testEnvironment().issuer).origin;
  const response = await fetch(origin + '/realms/master/protocol/openid-connect/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'local-admin', password: 'local-admin-only' }) });
  if (!response.ok) throw new Error('Admin local indisponível: ' + response.status);
  const { access_token: token } = await response.json() as { access_token: string };
  return (path: string, method = 'GET', body?: unknown) => fetch(origin + '/admin/realms/wagering' + path, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

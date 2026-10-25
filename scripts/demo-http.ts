import { readSeedConfiguration } from './seed-local';
import { uuidContract } from '../src/shared/application/contracts';

export async function demoHttp(api: string, issuer: string): Promise<Record<string, unknown>> {
  const configuration = readSeedConfiguration({ API_BASE_URL: api, OIDC_ISSUER: issuer });
  const json = async (url: string, options: RequestInit = {}): Promise<Record<string, unknown>> => {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Serviço local respondeu HTTP ${response.status}.`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Resposta local inválida.');
    return body as Record<string, unknown>;
  };
  const token = async (client: string, secret: string): Promise<string> => {
    const body = await json(`${configuration.issuer}/protocol/openid-connect/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: secret }),
    });
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('Keycloak não retornou access token.');
    return body.access_token;
  };
  const admin = await token('operations-console', 'local-operations-only');
  const provider = await token('provider-aurora', 'local-aurora-only');
  const request = (path: string, authorization: string, body?: unknown, key?: string) => json(`${api.replace(/\/$/u, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const playerId = crypto.randomUUID();
  const wallet = await request('/wallets', admin, { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  const walletId = uuidContract(wallet.id), key = crypto.randomUUID();
  const bet = { providerId: 'aurora', externalTransactionId: crypto.randomUUID(), playerId, walletId,
    roundId: 'round-demo', gameId: 'game-demo', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  const first = await request('/wagering/transactions', provider, bet, key);
  const replay = await request('/wagering/transactions', provider, bet, key);
  uuidContract(first.transactionId);
  const ledger = await request(`/wallets/${walletId}/ledger?limit=50`, admin);
  const reconciliation = await request(`/wallets/${walletId}/reconciliation`, admin, {});
  const balance = reconciliation.storedBalance as Record<string, unknown> | undefined;
  if (first.status !== 'PROCESSED' || replay.status !== 'PROCESSED' || first.idempotentReplay !== false
    || replay.idempotentReplay !== true || first.transactionId !== replay.transactionId
    || reconciliation.consistent !== true || reconciliation.checkedEntries !== 2
    || balance?.amount !== '75.00' || balance.currency !== 'BRL') {
    throw new Error('Demonstração HTTP não confirmou replay, saldo e ledger esperados.');
  }
  return { walletId, first, replay, ledger, reconciliation };
}

if (import.meta.main) {
  try {
    if (Bun.argv.length > 3) throw new Error('Informe somente a URL da API.');
    console.log(JSON.stringify(await demoHttp(Bun.argv[2] ?? process.env.API_BASE_URL ?? 'http://localhost:3000',
      process.env.OIDC_ISSUER ?? 'http://localhost:8180/realms/wagering'), null, 2));
  } catch {
    console.error('Demonstração HTTP falhou. Confira a URL local, Keycloak, migrations e API.');
    process.exitCode = 1;
  }
}

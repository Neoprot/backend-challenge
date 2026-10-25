import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { uuidContract } from '../src/shared/application/contracts';
import { Money } from '../src/shared/domain/money';
export interface SeedConfiguration { apiBaseUrl: string; issuer: string; sqsEndpoint: string; queueUrl: string; region: string; }
export interface SeedDependencies {
  request(url: string, options: RequestInit): Promise<Response>;
  send(queueUrl: string, envelope: Record<string, unknown>, groupId: string, deduplicationId: string): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}
export interface SeedResult { playerId: string; walletId: string; betTransactionId: string; winTransactionId: string; replayConfirmed: boolean; balance: { amount: string; currency: string }; reconciliation: { consistent: boolean; checkedEntries: number }; }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resposta local incompatível com o contrato.');
  return value as Record<string, unknown>;
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Serviço local respondeu HTTP ${response.status}.`);
  return object(await response.json());
}
export async function seedLocal(configuration: SeedConfiguration, dependencies: SeedDependencies): Promise<SeedResult> {
  const settings = readSeedConfiguration({ API_BASE_URL: configuration.apiBaseUrl, OIDC_ISSUER: configuration.issuer,
    SQS_ENDPOINT: configuration.sqsEndpoint, REQUEST_QUEUE_URL: configuration.queueUrl });
  const token = async (client: string, secret: string): Promise<string> => {
    const result = await json(await dependencies.request(`${settings.issuer}/protocol/openid-connect/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: secret }),
    }));
    if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Keycloak não retornou access token.');
    return result.access_token;
  };
  const [admin, provider] = await Promise.all([token('operations-console', 'local-operations-only'), token('provider-aurora', 'local-aurora-only')]);
  const request = (path: string, authorization: string, body?: unknown, key?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${authorization}` };
    const options: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(5000) };
    if (body !== undefined) { headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
    if (key !== undefined) headers['idempotency-key'] = key;
    return dependencies.request(`${settings.apiBaseUrl.replace(/\/$/u, '')}${path}`, options);
  };
  const playerId = crypto.randomUUID();
  const wallet = await json(await request('/wallets', admin, { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }));
  const walletId = uuidContract(wallet.id), key = crypto.randomUUID(), externalBet = crypto.randomUUID();
  const bet = { providerId: 'aurora', externalTransactionId: externalBet, playerId, walletId, roundId: crypto.randomUUID(),
    gameId: 'local-demo', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  const first = await json(await request('/wagering/transactions', provider, bet, key));
  const replay = await json(await request('/wagering/transactions', provider, bet, key));
  const betTransactionId = uuidContract(first.transactionId);
  if (first.status !== 'PROCESSED' || first.idempotentReplay !== false || replay.status !== 'PROCESSED'
    || replay.idempotentReplay !== true || replay.transactionId !== betTransactionId) throw new Error('Demonstração de replay não confirmou a mesma transação.');
  const externalWin = crypto.randomUUID(), messageId = crypto.randomUUID();
  await dependencies.send(settings.queueUrl, { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { ...bet, externalTransactionId: externalWin, idempotencyKey: crypto.randomUUID(), kind: 'WIN',
      money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: externalBet } }, walletId, messageId);
  let winTransactionId: string | undefined;
  const deadline = Date.now() + 30000;
  for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
    const response = await request(`/providers/aurora/wagering/transactions/${externalWin}`, provider);
    if (response.status !== 404) {
      const win = await json(response);
      if (win.status === 'PROCESSED') { winTransactionId = uuidContract(win.id); break; }
      if (win.status === 'REJECTED' || win.status === 'FAILED') throw new Error('WIN assíncrona terminou sem processamento.');
    }
    await dependencies.sleep(250);
  }
  if (!winTransactionId) throw new Error('WIN assíncrona não concluiu no prazo; confirme que os workers estão ativos.');
  const reconciliation = await json(await request(`/wallets/${walletId}/reconciliation`, admin, {}));
  const stored = object(reconciliation.storedBalance);
  const balance = Money.from({ amount: stored.amount as string, currency: stored.currency as string }).toJSON();
  if (reconciliation.consistent !== true || reconciliation.checkedEntries !== 3 || balance.amount !== '85.00' || balance.currency !== 'BRL') {
    throw new Error('Reconciliação da demonstração não confirmou o saldo e os três lançamentos esperados.');
  }
  return { playerId, walletId, betTransactionId, winTransactionId, replayConfirmed: true, balance,
    reconciliation: { consistent: true, checkedEntries: reconciliation.checkedEntries } };
}
export function readSeedConfiguration(environment: Record<string, string | undefined> = process.env): SeedConfiguration {
  const configuration = { apiBaseUrl: environment.API_BASE_URL ?? 'http://localhost:3000', issuer: environment.OIDC_ISSUER ?? 'http://localhost:8180/realms/wagering',
    sqsEndpoint: environment.SQS_ENDPOINT ?? 'http://localhost:4566',
    queueUrl: environment.REQUEST_QUEUE_URL ?? 'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo', region: 'us-east-1' };
  const local = (value: string): URL => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash) throw new Error();
      return url;
    } catch { throw new Error('Seed exige URLs HTTP locais sem credenciais, query ou fragmento.'); }
  };
  const api = local(configuration.apiBaseUrl), issuer = local(configuration.issuer), endpoint = local(configuration.sqsEndpoint), queue = local(configuration.queueUrl);
  if (api.pathname !== '/' || issuer.pathname !== '/realms/wagering' || endpoint.pathname !== '/'
    || !queue.pathname.endsWith('.fifo') || queue.port !== endpoint.port) throw new Error('Configuração local do seed incompatível com os serviços.');
  return configuration;
}

if (import.meta.main) {
  let client: SQSClient | undefined;
  try {
    const configuration = readSeedConfiguration();
    client = new SQSClient({ endpoint: configuration.sqsEndpoint, region: configuration.region,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
    const sqs = client;
    console.log(JSON.stringify(await seedLocal(configuration, {
      request: (url, options) => fetch(url, options), sleep: milliseconds => Bun.sleep(milliseconds),
      send: async (queueUrl, envelope, groupId, deduplicationId) => {
        const accepted = await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(envelope),
          MessageGroupId: groupId, MessageDeduplicationId: deduplicationId }), { abortSignal: AbortSignal.timeout(5000) });
        if (!accepted.MessageId) throw new Error('SQS não confirmou aceitação da mensagem.');
      },
    }), null, 2));
  } catch {
    console.error('Seed local falhou. Verifique URLs locais, serviços, migrations, credenciais de demonstração e workers ativos.');
    process.exitCode = 1;
  } finally { client?.destroy(); }
}

import { expect, test } from 'bun:test';
import { readSeedConfiguration, seedLocal, type SeedDependencies } from '../../scripts/seed-local';
test('seed local fornece destinos locais e aceita porta dinâmica da API', () => {
  expect(readSeedConfiguration({}).apiBaseUrl).toBe('http://localhost:3000');
  expect(readSeedConfiguration({ API_BASE_URL: 'http://127.0.0.1:49152' }).apiBaseUrl).toBe('http://127.0.0.1:49152');
});
for (const [key, value] of [
  ['API_BASE_URL', 'https://example.com'], ['OIDC_ISSUER', 'http://example.com/realms/wagering'],
  ['SQS_ENDPOINT', 'http://example.com:4566'], ['REQUEST_QUEUE_URL', 'http://example.com:4566/request.fifo'],
  ['API_BASE_URL', 'http://secret:password@localhost:3000'], ['API_BASE_URL', 'http://localhost:3000/?token=secret'],
  ['API_BASE_URL', 'http://localhost:3000/#secret'], ['API_BASE_URL', 'ftp://localhost:3000'],
  ['OIDC_ISSUER', 'http://localhost:8180/realms/other'], ['REQUEST_QUEUE_URL', 'http://localhost:4566/not-fifo'],
  ['REQUEST_QUEUE_URL', 'http://localhost:9999/queue.fifo'], ['API_BASE_URL', 'http://localhost:3000/prefix'],
]) test(`seed recusa destino inseguro ${key} ${value}`, () => {
  let error: unknown; try { readSeedConfiguration({ [key!]: value! }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(value!);
  expect((error as Error).message).not.toContain('password');
});
test('seed autentica, demonstra replay e espera WIN assíncrona antes da reconciliação', async () => {
  const walletId = crypto.randomUUID(), betId = crypto.randomUUID(), winId = crypto.randomUUID();
  const submissions: { body: unknown; key: string | null }[] = [], messages: Record<string, unknown>[] = [];
  let polls = 0;
  const dependencies: SeedDependencies = {
    request: async (url, options) => {
      expect(options.redirect).toBe('error');
      if (url.endsWith('/token')) return Response.json({ access_token: String(options.body).includes('operations-console') ? 'admin-token-secret' : 'provider-token-secret' });
      const headers = new Headers(options.headers);
      if (url.endsWith('/wallets')) { expect(headers.get('authorization')).toBe('Bearer admin-token-secret'); return Response.json({ id: walletId }, { status: 201 }); }
      if (url.endsWith('/wagering/transactions')) {
        expect(headers.get('authorization')).toBe('Bearer provider-token-secret');
        submissions.push({ body: JSON.parse(String(options.body)), key: headers.get('idempotency-key') });
        return Response.json({ transactionId: betId, status: 'PROCESSED', idempotentReplay: submissions.length > 1 });
      }
      if (url.includes('/providers/aurora/')) { polls++; return polls === 1 ? Response.json({}, { status: 404 }) : Response.json({ id: winId, status: 'PROCESSED' }); }
      if (url.endsWith('/reconciliation')) return Response.json({ consistent: true, checkedEntries: 3, storedBalance: { amount: '85.00', currency: 'BRL' } });
      throw new Error('URL inesperada.');
    },
    send: async (_queue, envelope) => { messages.push(envelope); }, sleep: async () => {},
  };
  const result = await seedLocal(readSeedConfiguration({}), dependencies);
  expect(result.walletId).toBe(walletId);
  expect(result.betTransactionId).toBe(betId); expect(result.winTransactionId).toBe(winId);
  expect(result.balance).toEqual({ amount: '85.00', currency: 'BRL' });
  expect(result.replayConfirmed).toBe(true); expect(result.reconciliation).toEqual({ consistent: true, checkedEntries: 3 });
  expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1]);
  expect(messages).toHaveLength(1); expect(messages[0]?.type).toBe('WagerTransactionRequested');
  expect(polls).toBe(2);
  expect(JSON.stringify(result)).not.toContain('token-secret');
});

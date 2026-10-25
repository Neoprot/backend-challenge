import { expect, test } from 'bun:test';
import { demoHttp } from '../../scripts/demo-http';

test('demonstração HTTP portátil verifica replay, ledger e saldo com autenticação real por HTTP', async () => {
  const walletId = crypto.randomUUID(), transactionId = crypto.randomUUID();
  const submissions: { body: unknown; key: string | null }[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/token')) {
      const form = await request.formData();
      return Response.json({ access_token: form.get('client_id') === 'operations-console' ? 'admin-secret' : 'provider-secret' });
    }
    if (path === '/wallets') {
      expect(request.headers.get('authorization')).toBe('Bearer admin-secret');
      return Response.json({ id: walletId }, { status: 201 });
    }
    if (path === '/wagering/transactions') {
      expect(request.headers.get('authorization')).toBe('Bearer provider-secret');
      submissions.push({ body: await request.json(), key: request.headers.get('idempotency-key') });
      return Response.json({ transactionId, status: 'PROCESSED', idempotentReplay: submissions.length > 1 });
    }
    if (path.endsWith('/ledger')) return Response.json({ items: [{}, {}] });
    return Response.json({ consistent: true, checkedEntries: 2, storedBalance: { amount: '75.00', currency: 'BRL' } });
  } });
  try {
    const result = await demoHttp(server.url.origin, `${server.url.origin}/realms/wagering`);
    expect(result.walletId).toBe(walletId);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    expect(JSON.stringify(result)).not.toContain('secret');
  } finally { await server.stop(true); }
});

test('demonstração recusa destinos remotos antes de enviar credenciais', async () => {
  await expect(demoHttp('https://example.com', 'http://localhost:8180/realms/wagering')).rejects.toThrow('locais');
});

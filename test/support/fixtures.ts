import type { WagerPayload } from '../../src/wagering/application/canonical-payload';
import type { ProcessingResponse } from '../../src/wagering/application/processing-result';
import type { HarnessNode } from './processes';
type HttpProcessingResponse = Omit<ProcessingResponse, 'httpStatus' | 'terminal'> & { correlationId: string };
export async function financialFixture(node: HarnessNode, adminToken: string, providerToken: string) {
  const playerId = crypto.randomUUID();
  const response = await fetch(node.base + '/wallets', { method: 'POST', headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }), signal: AbortSignal.timeout(10000) });
  if (response.status !== 201) throw new Error('Abertura da fixture falhou: ' + response.status);
  const wallet = await response.json() as { id: string };
  return { walletId: wallet.id, playerId,
    command: (patch: Partial<WagerPayload> = {}): WagerPayload => ({ providerId: 'aurora', externalTransactionId: crypto.randomUUID(),
      playerId, walletId: wallet.id, roundId: 'concurrency-round', gameId: 'concurrency-game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, ...patch }),
    submit: (target: HarnessNode, command: WagerPayload, key = crypto.randomUUID()) => submitHttp(target, command, key, providerToken),
  };
}
export async function submitHttp(node: HarnessNode, command: WagerPayload, key: string, token: string): Promise<HttpProcessingResponse> {
  const response = await fetch(node.base + '/wagering/transactions', { method: 'POST', headers: { authorization: 'Bearer ' + token,
    'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
  if (![200, 202, 422].includes(response.status)) throw new Error('Submit HTTP falhou: ' + response.status);
  return await response.json() as HttpProcessingResponse;
}

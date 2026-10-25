import { ApplicationError } from './application-error';
import { Money } from '../domain/money';
import { canonicalPayload, type WagerPayload } from '../../wagering/application/canonical-payload';

function invalid(): never { throw new ApplicationError('INVALID_REQUEST', 'Contrato de entrada inválido.', 400); }
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value;
}
export function stringContract(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value;
}
export function uuidContract(input: unknown): string {
  const value = stringContract(input, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) invalid();
  return value.toLowerCase();
}
function moneyContract(input: unknown): Money {
  const value = object(input, ['amount', 'currency']);
  return Money.from({ amount: stringContract(value.amount, 128), currency: stringContract(value.currency, 3) });
}
export function openWalletContract(input: unknown): { playerId: string; initialBalance: Money } {
  const value = object(input, ['playerId', 'initialBalance']);
  return { playerId: uuidContract(value.playerId), initialBalance: moneyContract(value.initialBalance) };
}
export function wagerContract(input: unknown): WagerPayload {
  const value = object(input, ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId']);
  const kind = value.kind;
  if (kind !== 'BET' && kind !== 'WIN' && kind !== 'LOSS' && kind !== 'REFUND' && kind !== 'ROLLBACK') invalid();
  const payload: WagerPayload = {
    providerId: stringContract(value.providerId, 120), externalTransactionId: stringContract(value.externalTransactionId, 200),
    playerId: uuidContract(value.playerId), walletId: uuidContract(value.walletId),
    roundId: stringContract(value.roundId, 200), gameId: stringContract(value.gameId, 200), kind,
    money: moneyContract(value.money).toJSON(),
  };
  if ('referenceExternalTransactionId' in value) payload.referenceExternalTransactionId = stringContract(value.referenceExternalTransactionId, 200);
  return canonicalPayload(payload).payload;
}
export function ledgerQuery(input: unknown): { limit?: number; cursor?: string } {
  const value = object(input, ['limit', 'cursor']);
  const result: { limit?: number; cursor?: string } = {};
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'string' || !/^[0-9]{1,3}$/u.test(value.limit)) invalid();
    result.limit = Number(value.limit);
    if (result.limit < 1 || result.limit > 100) invalid();
  }
  if (value.cursor !== undefined) result.cursor = stringContract(value.cursor, 2048);
  return result;
}
export function correlationId(input: unknown): string {
  return typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input) ? input : crypto.randomUUID();
}

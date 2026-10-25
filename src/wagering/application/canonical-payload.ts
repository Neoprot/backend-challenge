import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../shared/domain/money';
import { DomainError } from '../../shared/domain/domain-error';
import type { WagerTransactionKind } from '../domain/wager-transaction';

export interface WagerPayload {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: Exclude<WagerTransactionKind, 'OPENING'>;
  money: MoneyProps; referenceExternalTransactionId?: string;
}
function invalid(): never { throw new DomainError('INVALID_PAYLOAD', 'Contrato de transação inválido.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value;
}
function uuid(value: unknown): string {
  const result = string(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) invalid();
  return result.toLowerCase();
}
function sorted(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sorted(entry)]));
  }
  return value;
}
export function canonicalPayload(input: unknown): { payload: WagerPayload; hash: string } {
  const value = object(input);
  const kind = string(value.kind, 16);
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) invalid();
  const monetary = object(value.money);
  const money = Money.from({ amount: monetary.amount as string, currency: monetary.currency as string });
  if (kind === 'LOSS' ? !money.isZero() : !money.isPositive()) invalid();
  const payload: WagerPayload = {
    providerId: string(value.providerId, 120), externalTransactionId: string(value.externalTransactionId, 200),
    playerId: uuid(value.playerId), walletId: uuid(value.walletId), roundId: string(value.roundId, 200), gameId: string(value.gameId, 200),
    kind: kind as WagerPayload['kind'], money: money.toJSON(),
  };
  if (value.referenceExternalTransactionId !== undefined) payload.referenceExternalTransactionId = string(value.referenceExternalTransactionId, 200);
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && payload.referenceExternalTransactionId === undefined) invalid();
  if (payload.referenceExternalTransactionId === payload.externalTransactionId) invalid();
  return { payload, hash: createHash('sha256').update(JSON.stringify(sorted(payload))).digest('hex') };
}


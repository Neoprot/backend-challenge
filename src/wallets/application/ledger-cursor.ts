import type { LedgerPosition } from './wallet-queries';
import { ApplicationError } from '../../shared/application/application-error';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function invalid(): never { throw new ApplicationError('INVALID_CURSOR', 'Cursor de ledger inválido para esta carteira.', 400); }
export function ledgerLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new ApplicationError('INVALID_LIMIT', 'Limite deve ser inteiro entre 1 e 100.', 400);
  }
  return value;
}
export function encodeLedgerCursor(position: LedgerPosition): string { return Buffer.from(JSON.stringify(position)).toString('base64url'); }
export function decodeLedgerCursor(value: unknown, walletId: string): LedgerPosition {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalid();
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalid();
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch { invalid(); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalid();
  const record = decoded as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'createdAt,id,version,walletId' || record.version !== 1 || record.walletId !== walletId ||
      typeof record.walletId !== 'string' || !uuid.test(record.walletId) || typeof record.id !== 'string' || !uuid.test(record.id) ||
      typeof record.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(record.createdAt)) invalid();
  const millisecondDate = record.createdAt.slice(0, 23) + 'Z';
  const parsed = new Date(millisecondDate);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 1 || parsed.toISOString() !== millisecondDate) invalid();
  return { version: 1, walletId: record.walletId, id: record.id, createdAt: record.createdAt };
}

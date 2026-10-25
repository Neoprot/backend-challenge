import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { Money } from '../../src/shared/domain/money';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';

export async function referenceFixture(orm: MikroORM, initial = '100.00') {
  const ids = new UuidIdentifiers();
  const at = new Date('2026-10-25T12:00:00.000Z');
  const clock = { now: () => at };
  const uow = new PostgresUnitOfWork(orm);
  const wallet = await new OpenWallet(uow, clock, ids).execute({ playerId: ids.next(),
    initialBalance: Money.from({ amount: initial, currency: 'BRL' }), correlationId: ids.next() });
  const service = new SubmitWager(uow, clock, ids);
  const command = (kind: string, amount: string, reference?: string, overrides: Record<string, unknown> = {}) => ({
    providerId: 'aurora', externalTransactionId: ids.next(), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' },
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }), ...overrides,
  });
  const context = () => ({ idempotencyKey: ids.next(), correlationId: ids.next() });
  return { ids, at, wallet, service, command, context };
}

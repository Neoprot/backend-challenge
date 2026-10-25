import { expect, test } from 'bun:test';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import type { FinancialSession, UnitOfWork } from '../../src/shared/application/unit-of-work';
import { Money } from '../../src/shared/domain/money';
import type { Wallet } from '../../src/wallets/domain/wallet';
import type { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import type { WalletLedgerEntry } from '../../src/wallets/domain/ledger-entry';
import type { IntegrationEvent } from '../../src/messaging/domain/integration-event';

const at = new Date('2026-10-25T12:00:00.000Z');
function fixture() {
  const wallets: Wallet[] = [], wagers: WagerTransaction[] = [], entries: WalletLedgerEntry[] = [], events: IntegrationEvent<unknown>[] = [];
  let sequence = 0, runs = 0;
  const session: FinancialSession = {
    insertWallet: async value => { wallets.push(value); }, insertWager: async value => { wagers.push(value); },
    insertLedger: async value => { entries.push(value); }, enqueue: async value => { events.push(value); },
  };
  const uow: UnitOfWork = { run: async work => { runs++; return work(session); } };
  const ids = { next: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
  return { wallets, wagers, entries, events, session, uow, ids, runs: () => runs,
    opener: new OpenWallet(uow, { now: () => at }, ids) };
}

test('abertura usa clock e identificadores injetados em uma única unidade', async () => {
  const f = fixture();
  const wallet = await f.opener.execute({ playerId: 'player', initialBalance: Money.from({ amount: '15.00', currency: 'BRL' }), correlationId: 'correlation' });
  expect(f.runs()).toBe(1); expect(f.wallets).toEqual([wallet]);
  expect(wallet.id).toBe('00000000-0000-4000-8000-000000000001');
  expect(wallet.createdAt).toEqual(at); expect(wallet.version).toBe(1);
  expect(f.wagers).toHaveLength(1); expect(f.entries).toHaveLength(1); expect(f.events).toHaveLength(2);
  expect(f.wagers[0]!.kind).toBe('OPENING'); expect(f.wagers[0]!.status).toBe('PROCESSED');
  expect(f.entries[0]!.transactionId).toBe(f.wagers[0]!.id);
  expect(f.entries[0]!.balanceBefore.toJSON().amount).toBe('0.00');
  expect(f.events.map(e => e.eventId)).toEqual(['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005']);
  for (const event of f.events) { expect(event.correlationId).toBe('correlation'); expect(event.occurredAt).toEqual(at); }
});

test('zero persiste somente a wallet', async () => {
  const f = fixture();
  await f.opener.execute({ playerId: 'player', initialBalance: Money.zero('BRL'), correlationId: 'correlation' });
  expect(f.runs()).toBe(1); expect(f.wallets).toHaveLength(1);
  expect(f.wagers).toHaveLength(0); expect(f.entries).toHaveLength(0); expect(f.events).toHaveLength(0);
});

test('erro de persistência interrompe o fluxo e mantém a causa original', async () => {
  const f = fixture();
  const failure = new Error('Persistência indisponível');
  f.session.insertWallet = async () => { throw failure; };
  let received: unknown;
  try { await f.opener.execute({ playerId: 'player', initialBalance: Money.from({ amount: '15.00', currency: 'BRL' }), correlationId: 'correlation' }); } catch (error) { received = error; }
  expect(received).toBe(failure); expect(f.wagers).toHaveLength(0); expect(f.entries).toHaveLength(0); expect(f.events).toHaveLength(0);
});

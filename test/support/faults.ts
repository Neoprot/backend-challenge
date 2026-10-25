import type { FinancialSession, UnitOfWork } from '../../src/shared/application/unit-of-work';

export function failAfter(uow: UnitOfWork, method: 'insertWallet' | 'insertWager' | 'insertLedger' | 'enqueue', error: Error, reached: () => void): UnitOfWork {
  return { run: work => uow.run(session => {
    const wrapped: FinancialSession = {
      lockWallet: value => session.lockWallet(value),
      saveWallet: value => session.saveWallet(value),
      insertWallet: async value => { await session.insertWallet(value); if (method === 'insertWallet') { reached(); throw error; } },
      insertWager: async value => { await session.insertWager(value); if (method === 'insertWager') { reached(); throw error; } },
      insertLedger: async value => { await session.insertLedger(value); if (method === 'insertLedger') { reached(); throw error; } },
      enqueue: async value => { await session.enqueue(value); if (method === 'enqueue') { reached(); throw error; } },
    };
    return work(wrapped);
  }) };
}

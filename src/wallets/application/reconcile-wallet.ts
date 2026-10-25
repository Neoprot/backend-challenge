import type { WalletQueries, ReconciliationView } from './wallet-queries';
import { ApplicationError } from '../../shared/application/application-error';
export class ReconcileWallet {
  constructor(private readonly queries: WalletQueries) {}
  async execute(walletId: string): Promise<ReconciliationView> {
    const result = await this.queries.reconcile(walletId);
    if (result === undefined) throw new ApplicationError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404);
    return result;
  }
}

import type { WalletQueries, ReconciliationView } from './wallet-queries';
import { ApplicationError } from '../../shared/application/application-error';
import { noObservation, observe, type Observation } from '../../shared/application/observation';
export class ReconcileWallet {
  constructor(private readonly queries: WalletQueries, private readonly observation: Observation = noObservation) {}
  async execute(walletId: string): Promise<ReconciliationView> {
    const result = await this.queries.reconcile(walletId);
    if (result === undefined) throw new ApplicationError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404);
    observe(this.observation, result.consistent ? 'reconciliation_checked' : 'reconciliation_divergence', { walletId, component: 'reconciliation' });
    return result;
  }
}

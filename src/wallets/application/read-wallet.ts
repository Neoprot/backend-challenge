import type { WalletQueries, WalletView } from './wallet-queries';
import { ApplicationError } from '../../shared/application/application-error';
export class ReadWallet {
  constructor(private readonly queries: WalletQueries) {}
  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.queries.readWallet(walletId);
    if (wallet === undefined) throw new ApplicationError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404);
    return wallet;
  }
}

import { RequiredAccess } from '../identity/public';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { OpenWallet } from '../wallets/application/open-wallet';
import { ReadWallet } from '../wallets/application/read-wallet';
import { ListLedger } from '../wallets/application/list-ledger';
import { ReconcileWallet } from '../wallets/application/reconcile-wallet';
import { ledgerQuery, openWalletContract, uuidContract } from './contracts';
import type { HttpRequest } from './error.filter';

@RequiredAccess('admin')
@Controller('wallets')
export class WalletsController {
  constructor(@Inject(OpenWallet) private readonly open: OpenWallet, @Inject(ReadWallet) private readonly read: ReadWallet,
    @Inject(ListLedger) private readonly ledger: ListLedger, @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet) {}
  @Post()
  async create(@Body() input: unknown, @Req() request: HttpRequest) {
    const wallet = await this.open.execute({ ...openWalletContract(input), correlationId: request.correlationId! });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
  @Get(':walletId')
  get(@Param('walletId') id: unknown) { return this.read.execute(uuidContract(id)); }
  @Get(':walletId/ledger')
  list(@Param('walletId') id: unknown, @Query() query: unknown) { return this.ledger.execute(uuidContract(id), ledgerQuery(query)); }
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') id: unknown) { return this.reconcile.execute(uuidContract(id)); }
}

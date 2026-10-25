import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { SubmitWager } from '../wagering/application/submit-wager';
import { ReadTransaction } from '../wagering/application/read-transaction';
import { ApplicationError } from '../shared/application/application-error';
import { stringContract, uuidContract, wagerContract } from './contracts';
import type { HttpRequest, HttpResponse } from './error.filter';

@Controller()
export class WageringController {
  constructor(@Inject(SubmitWager) private readonly submit: SubmitWager, @Inject(ReadTransaction) private readonly read: ReadTransaction) {}
  @Post('wagering/transactions')
  async create(@Body() input: unknown, @Headers('idempotency-key') key: unknown, @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse) {
    if (typeof key !== 'string' || !key.trim() || key.length > 320) {
      throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key é obrigatória e deve ter até 320 caracteres.', 400);
    }
    const result = await this.submit.execute(wagerContract(input), { idempotencyKey: key, correlationId: request.correlationId! });
    response.status(result.httpStatus);
    const { httpStatus: _status, terminal: _terminal, ...body } = result;
    return { ...body, correlationId: request.correlationId };
  }
  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') id: unknown) { return this.read.byId(uuidContract(id)); }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(@Param('providerId') providerId: unknown, @Param('externalTransactionId') externalId: unknown) {
    return this.read.byExternal(stringContract(providerId, 120), stringContract(externalId, 200));
  }
}

import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import { DomainError } from '../shared/domain/domain-error';
import { ApplicationError } from '../shared/application/application-error';
import { IdempotencyConflict } from '../wagering/application/idempotency';
import { correlationId } from './contracts';
import { isTransientFailure } from '../shared/application/transient-failure';

export interface HttpRequest { headers: Record<string, unknown>; correlationId?: string; }
export interface HttpResponse { status(value: number): HttpResponse; json(value: unknown): void; setHeader(name: string, value: string): void; }
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<HttpRequest>();
    const response = context.getResponse<HttpResponse>();
    const id = request.correlationId ?? correlationId(request.headers['x-correlation-id']);
    const { status, code, message } = publicError(error);
    response.setHeader('X-Correlation-Id', id);
    response.status(status).json({ code, message, correlationId: id });
  }
}
function publicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ApplicationError || error instanceof IdempotencyConflict) return { status: error.httpStatus, code: error.code, message: error.message };
  if (error instanceof DomainError) return { status: error.code === 'WALLET_ALREADY_EXISTS' ? 409 : 400, code: error.code, message: error.message };
  if (isTransientFailure(error)) return { status: 503, code: 'DEPENDENCIES_UNAVAILABLE', message: 'Dependências temporariamente indisponíveis.' };
  const status = error instanceof HttpException ? error.getStatus() : parserStatus(error);
  if (status === 400 || status === 413 || status === 415) return { status, code: 'INVALID_REQUEST', message: 'Requisição inválida.' };
  if (status === 404 || status === 405) return { status, code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada.' };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno.' };
}
function parserStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'type' in error && 'status' in error &&
    ['entity.parse.failed', 'entity.too.large', 'charset.unsupported', 'encoding.unsupported'].includes(String(error.type))) {
    return typeof error.status === 'number' ? error.status : 500;
  }
  return 500;
}

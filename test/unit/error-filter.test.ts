import { expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { ErrorFilter } from '../../src/http/error.filter';

function responseFor(error: unknown) {
  let status = 0;
  let body: unknown;
  const response = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; },
    setHeader() {},
  };
  const host = { switchToHttp: () => ({
    getRequest: () => ({ headers: {}, correlationId: 'query-test' }),
    getResponse: () => response,
  }) } as unknown as ArgumentsHost;
  new ErrorFilter().catch(error, host);
  return { status, body };
}

test.each(['ECONNRESET', 'ECONNREFUSED', '08006', '57P01'])('consulta com falha transitória %s retorna 503 sanitizado', code => {
  const result = responseFor(Object.assign(new Error('SQL e credenciais privados'), { code }));
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ code: 'DEPENDENCIES_UNAVAILABLE', correlationId: 'query-test' });
  expect(JSON.stringify(result.body)).not.toContain('privados');
});

test('falha desconhecida permanece 500 sem expor detalhes internos', () => {
  const result = responseFor(Object.assign(new Error('detalhe privado'), { code: 42 }));
  expect(result.status).toBe(500);
  expect(result.body).toMatchObject({ code: 'INTERNAL_ERROR', correlationId: 'query-test' });
  expect(JSON.stringify(result.body)).not.toContain('privado');
});

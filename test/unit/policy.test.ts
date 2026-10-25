import { expect, test } from 'bun:test';
import { ForbiddenException } from '@nestjs/common';
import { ProviderPolicy } from '../../src/identity/provider-policy';
import type { Principal } from '../../src/identity/principal';
const policy = new ProviderPolicy();
const provider: Principal = { subject: 'service-provider', roles: ['wagering-provider'], providerId: 'aurora' };
const admin: Principal = { subject: 'service-admin', roles: ['wagering-admin'] };
test('identidade válida sem papel não autoriza', () => {
  const anonymous = { subject: 'valid', roles: [], providerId: 'aurora' };
  expect(() => policy.submit(anonymous, 'aurora')).toThrow(ForbiddenException);
  expect(() => policy.read(anonymous, 'aurora')).toThrow(ForbiddenException);
  expect(() => policy.admin(anonymous)).toThrow(ForbiddenException);
});
test('provedor não pode divergir da identidade assinada', () => {
  expect(() => policy.submit(provider, 'horizonte')).toThrow(ForbiddenException);
  expect(() => policy.admin(provider)).toThrow(ForbiddenException);
  policy.submit(provider, 'aurora');
});
test('consulta por ID interno verifica provedor do recurso', () => {
  expect(() => policy.read(provider, 'horizonte')).toThrow(ForbiddenException);
  policy.read(provider, 'aurora');
});
test('admin consulta globalmente e não submete sem identidade de provedor', () => {
  policy.admin(admin); policy.read(admin, 'horizonte');
  expect(() => policy.submit(admin, 'aurora')).toThrow(ForbiddenException);
});

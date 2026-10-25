import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KeycloakVerifier } from './keycloak-verifier';
import { ProviderPolicy, type AccessRule } from './provider-policy';
import { ACCESS_RULE, IS_PUBLIC } from './public';
import type { HttpRequest } from '../http/error.filter';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector,
    @Inject(KeycloakVerifier) private readonly verifier: KeycloakVerifier) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true) return true;
    const request = context.switchToHttp().getRequest<HttpRequest>();
    request.principal = await this.verifier.verify(request.headers.authorization);
    new ProviderPolicy().authorize(request.principal, this.reflector.getAllAndOverride<AccessRule>(ACCESS_RULE, targets));
    return true;
  }
}


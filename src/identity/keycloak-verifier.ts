import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Configuration } from '../bootstrap/config';
import type { Clock } from '../shared/domain/clock';
import { SystemClock } from '../shared/domain/clock';
import type { Principal } from './principal';

export function principalFromClaims(payload: JWTPayload): Principal {
  const access = payload.realm_access;
  if (payload.typ !== 'Bearer' || typeof payload.sub !== 'string' || !payload.sub.trim() ||
      (payload.providerId !== undefined && (typeof payload.providerId !== 'string' || !payload.providerId.trim() || payload.providerId.length > 120))) {
    throw new UnauthorizedException();
  }
  let roles: string[] = [];
  if (access !== undefined) {
    if (!access || typeof access !== 'object' || Array.isArray(access) || !('roles' in access) ||
        !Array.isArray(access.roles) || !access.roles.every((role: unknown) => typeof role === 'string')) throw new UnauthorizedException();
    roles = [...access.roles];
  }
  return Object.freeze({ subject: payload.sub, roles: Object.freeze(roles),
    ...(typeof payload.providerId === 'string' ? { providerId: payload.providerId } : {}) });
}

export class KeycloakVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly configuration: Pick<Configuration, 'issuer' | 'audience' | 'jwksUri'>,
    private readonly clock: Clock = new SystemClock(), cooldownDuration = 5000) {
    // A URL é da configuração confiável, nunca dos headers jku/x5u do token.
    this.keys = createRemoteJWKSet(new URL(configuration.jwksUri ?? configuration.issuer + '/protocol/openid-connect/certs'), {
      cooldownDuration, timeoutDuration: 2000, cacheMaxAge: 600000,
      [customFetch]: async (url, options) => {
        try {
          const response = await fetch(url, { ...options, redirect: 'error' });
          if (response.status !== 200) throw new Error('JWKS indisponível');
          return response;
        } catch { throw new ServiceUnavailableException(); }
      },
    });
  }
  async verify(authorization: unknown): Promise<Principal> {
    if (typeof authorization !== 'string' || authorization.length > 16384 ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization)) throw new UnauthorizedException();
    try {
      const { payload } = await jwtVerify(authorization.slice(7), async (header, token) => {
        try { return await this.keys(header, token); }
        catch (error) {
          // Seleção sem chave única é token inválido; demais falhas pertencem à dependência JWKS.
          if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) throw error;
          throw new ServiceUnavailableException();
        }
      }, {
        algorithms: ['RS256'], issuer: this.configuration.issuer, audience: this.configuration.audience,
        requiredClaims: ['exp', 'sub', 'aud', 'iss', 'typ'], currentDate: this.clock.now(),
      });
      return principalFromClaims(payload);
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof errors.JWKSTimeout ||
          error instanceof errors.JWKSInvalid) throw new ServiceUnavailableException();
      if (error instanceof errors.JOSEError || error instanceof UnauthorizedException) throw new UnauthorizedException();
      throw new ServiceUnavailableException();
    }
  }
}

import { ForbiddenException } from '@nestjs/common';
import type { Principal } from './principal';
export type AccessRule = 'admin' | 'provider' | 'transaction-read';
export class ProviderPolicy {
  admin(principal: Principal): void { if (!principal.roles.includes('wagering-admin')) throw new ForbiddenException(); }
  provider(principal: Principal): void {
    if (!principal.roles.includes('wagering-provider') || !principal.providerId) throw new ForbiddenException();
  }
  submit(principal: Principal, providerId: string): void {
    this.provider(principal);
    if (principal.providerId !== providerId) throw new ForbiddenException();
  }
  read(principal: Principal, providerId: string): void {
    if (principal.roles.includes('wagering-admin')) return;
    this.submit(principal, providerId);
  }
  authorize(principal: Principal, rule: AccessRule | undefined): void {
    if (rule === 'admin') return this.admin(principal);
    if (rule === 'provider') return this.provider(principal);
    if (rule === 'transaction-read') {
      if (principal.roles.includes('wagering-admin')) return;
      return this.provider(principal);
    }
    throw new ForbiddenException();
  }
}


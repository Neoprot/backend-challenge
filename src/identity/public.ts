import { SetMetadata } from '@nestjs/common';
import type { AccessRule } from './provider-policy';
export const IS_PUBLIC = Symbol('public-health');
export const ACCESS_RULE = Symbol('access-rule');
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequiredAccess = (rule: AccessRule) => SetMetadata(ACCESS_RULE, rule);

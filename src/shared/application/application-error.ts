import { DomainError } from '../domain/domain-error';

export class ApplicationError extends DomainError {
  constructor(code: string, message: string, readonly httpStatus: number) { super(code, message); }
}

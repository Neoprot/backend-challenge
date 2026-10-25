import { AsyncLocalStorage } from 'node:async_hooks';
export interface ExecutionContext { correlationId?: string; messageId?: string; transactionId?: string; walletId?: string; providerId?: string; }
const storage = new AsyncLocalStorage<ExecutionContext>();
export function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/u.test(value) ? value : undefined;
}
export function sanitizeContext(input: ExecutionContext): ExecutionContext {
  const result: ExecutionContext = {};
  for (const key of ['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId'] as const) {
    const value = safeIdentifier(input[key]); if (value !== undefined) result[key] = value;
  }
  return result;
}
export function currentContext(): Readonly<ExecutionContext> | undefined {
  const context = storage.getStore(); return context === undefined ? undefined : Object.freeze({ ...context });
}
/** Atualiza somente o armazenamento criado para esta execução; leitores recebem cópias imutáveis. */
export function enrichContext(context: ExecutionContext): void {
  const store = storage.getStore(); if (store !== undefined) Object.assign(store, sanitizeContext(context));
}
export function runWithContext<T>(context: ExecutionContext, work: () => T): T {
  const safe = sanitizeContext(context);
  safe.correlationId ??= crypto.randomUUID();
  return storage.run(safe, work);
}

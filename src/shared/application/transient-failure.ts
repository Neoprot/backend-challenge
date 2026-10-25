/** Falhas técnicas para as quais uma nova tentativa pode ser útil. */
export function isTransientFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if (isConnectionLostFailure(error)) return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (code.startsWith('08') || [
    '40P01', '40001', '55P03', '57014', '57P01', '57P02', '57P03',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND',
  ].includes(code));
}

/** Sinais estreitos de conexão morta; timeout/serialization/constraint não provam isso. */
export function isConnectionLostFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && ['08003', '08006', '57P01', '57P02', 'ECONNRESET', 'EPIPE'].includes(code)) return true;
  return error instanceof Error && [
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
    'Connection terminated',
    'Connection terminated unexpectedly',
  ].includes(error.message);
}

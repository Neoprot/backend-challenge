/** Falhas técnicas para as quais uma nova tentativa pode ser útil. */
export function isTransientFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (code.startsWith('08') || [
    '40P01', '40001', '55P03', '57014', '57P01', '57P02', '57P03',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ENOTFOUND',
  ].includes(code));
}

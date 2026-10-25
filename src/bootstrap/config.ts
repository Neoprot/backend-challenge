export interface Configuration {
  readonly databaseUrl: string;
  readonly sqsEndpoint: string;
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri?: string;
  readonly port: number;
  readonly region: string;
}

export function readConfiguration(environment: Record<string, string | undefined>): Configuration {
  const required = (key: string): string => {
    const value = environment[key];
    if (!value?.trim()) throw new Error(`${key} obrigatória`);
    return value;
  };
  const url = (key: string, protocols: readonly string[]): string => {
    const value = required(key);
    try {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch {
      throw new Error(`${key} inválida`);
    }
    return value;
  };
  const databaseUrl = url('DATABASE_URL', ['postgres:', 'postgresql:']);
  const sqsEndpoint = url('SQS_ENDPOINT', ['http:', 'https:']);
  const issuer = url('OIDC_ISSUER', ['http:', 'https:']);
  const audience = required('OIDC_AUDIENCE');
  const jwksUri = environment.OIDC_JWKS_URI === undefined ? undefined : url('OIDC_JWKS_URI', ['http:', 'https:']);
  const rawPort = environment.PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT inválida');
  }
  return Object.freeze({ databaseUrl, sqsEndpoint, issuer, audience, ...(jwksUri === undefined ? {} : { jwksUri }), port, region: environment.AWS_REGION ?? 'us-east-1' });
}

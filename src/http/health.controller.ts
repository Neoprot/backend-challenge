import { Public } from '../identity/public';
import { Controller, Get, Inject } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { ApplicationError } from '../shared/application/application-error';

export class Readiness {
  constructor(private readonly orm: MikroORM, private readonly sqs: SQSClient) {}
  async execute(): Promise<{ status: 'ready' }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 1500);
    });
    try {
      const results = await Promise.race([Promise.allSettled([
        this.orm.em.fork().execute('select 1', [], { signal: controller.signal, inflightQueryAbortStrategy: 'cancel query' }),
        this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: controller.signal }),
      ]), timeout]);
      if (results.some(result => result.status === 'rejected')) throw new Error('dependency unavailable');
      return { status: 'ready' };
    } catch {
      throw new ApplicationError('DEPENDENCIES_UNAVAILABLE', 'Dependências temporariamente indisponíveis.', 503);
    } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
}
@Controller('health')
export class HealthController {
  constructor(@Inject(Readiness) private readonly readiness: Readiness) {}
  @Public()
  @Get('live')
  live() { return { status: 'alive' }; }
  @Public()
  @Get('ready')
  ready() { return this.readiness.execute(); }
}

import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { RequiredAccess } from '../identity/public';
import { ORM } from '../bootstrap/tokens';
import { ApplicationObservation } from './observation';
import { boundedRead } from './read-probe';
@Controller('metrics')
export class MetricsController {
  private refresh: Promise<void> | undefined;
  constructor(@Inject(ApplicationObservation) private readonly observation: ApplicationObservation, @Inject(ORM) private readonly orm: MikroORM) {}
  @RequiredAccess('admin')
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    // Scrapes simultâneos compartilham a leitura limitada; falha preserva o último valor.
    this.refresh ??= this.readLag().finally(() => { this.refresh = undefined; });
    await this.refresh;
    return this.observation.metrics.render();
  }
  private async readLag(): Promise<void> {
    try {
      const rows = await boundedRead<{ lag: string | number }[]>(this.orm,
        'select coalesce(greatest(0, extract(epoch from (statement_timestamp() - min(occurred_at)))), 0) as lag from outbox_message where published_at is null');
      if (rows[0]) this.observation.metrics.setOutboxLag(Number(rows[0].lag));
    } catch { /* Métricas locais permanecem disponíveis durante indisponibilidade do banco. */ }
  }
}

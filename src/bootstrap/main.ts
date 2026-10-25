import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SQSClient } from '@aws-sdk/client-sqs';
import { readConfiguration, type Configuration } from './config';
import { createOrm } from '../persistence/orm';
import { AppModule } from './app.module';
import { ErrorFilter, type HttpRequest, type HttpResponse } from '../http/error.filter';
import { correlationId } from '../http/contracts';

export async function createApplication(configuration: Configuration, options: { lockTimeoutMs?: number } = {}) {
  const orm = await createOrm(configuration.databaseUrl);
  const sqs = new SQSClient({ endpoint: configuration.sqsEndpoint, region: configuration.region, maxAttempts: 1,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } });
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule.register(configuration, orm, sqs, options),
      { logger: false, bodyParser: false, abortOnError: false });
    app.use((request: HttpRequest, response: HttpResponse, next: () => void) => {
      request.correlationId = correlationId(request.headers['x-correlation-id']);
      response.setHeader('X-Correlation-Id', request.correlationId);
      next();
    });
    app.useBodyParser('json', { limit: '64kb' });
    app.useGlobalFilters(new ErrorFilter());
    return app;
  } catch (error) { sqs.destroy(); await orm.close(true); throw error; }
}

export async function bootstrap() {
  const configuration = readConfiguration(process.env);
  const app = await createApplication(configuration);
  app.enableShutdownHooks();
  try { await app.listen(configuration.port, '0.0.0.0'); }
  catch (error) { await app.close(); throw error; }
  return app;
}
if (import.meta.main) await bootstrap();

import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const TOKEN = Symbol('runtime-smoke');
@Injectable()
class Probe {
  constructor(@Inject(TOKEN) readonly value: string) {}
}
@Module({ providers: [{ provide: TOKEN, useValue: 'bun-ready' }, Probe] })
class ProbeModule {}

test('Bun executa NestJS com injeção explícita', async () => {
  const app = await NestFactory.createApplicationContext(ProbeModule, { logger: false });
  try { expect(app.get(Probe).value).toBe('bun-ready'); }
  finally { await app.close(); }
});

import './test-env.js';
import type { INestApplication, Provider, Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { envConfig, type Env } from '../../src/config/env.js';

export interface TestApp {
  app: INestApplication<App>;
  http: App;
  moduleRef: TestingModule;
  dataSource: DataSource;
  get<T>(token: Type<T> | string | symbol): T;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule on the test database with the production HTTP setup
 * (prefix, middleware, guards, pipe, filter). Extra controllers/providers let a
 * suite mount test-only routes.
 */
export async function createApp(
  options: { controllers?: Type<unknown>[]; providers?: Provider[] } = {},
): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  }).compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: ['error'] });
  configureApp(app, app.get<Env>(envConfig.KEY));
  await app.init();

  return {
    app,
    http: app.getHttpServer(),
    moduleRef,
    dataSource: app.get(DataSource),
    get: <T>(token: Type<T> | string | symbol) => app.get<T>(token as Type<T>),
    close: () => app.close(),
  };
}

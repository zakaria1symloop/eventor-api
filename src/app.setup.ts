import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { CorsIoAdapter } from './common/http/cors-io.adapter.js';
import { requestIdMiddleware } from './common/request-context/request-id.middleware.js';
import { corsList, type Env } from './config/env.js';

/**
 * The leading slash matters: Nest 12 mounts its not-found handler at the raw
 * prefix, and Express never matches a mount path without one, so unknown routes
 * would fall through to Express's HTML 404 instead of the JSON error body.
 */
export const API_PREFIX = '/api/v1';

/**
 * Everything applied to the HTTP application itself. Shared by main.ts and the
 * e2e tests, so tests run with the same prefix, headers and CORS policy as
 * production. Validation, errors and guards are global providers in AppModule.
 */
export function configureApp(app: INestApplication, env: Env): void {
  app.setGlobalPrefix(API_PREFIX);
  // Behind Nginx: trust the first proxy so client IPs are the real ones.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  const express = app as unknown as NestExpressApplication;
  express.disable('x-powered-by');
  // First, so that every response carries a request id and gets its log line —
  // including the ones the body parser rejects below (malformed JSON, 413).
  app.use(requestIdMiddleware({ log: env.LOG_REQUESTS }));
  // Files are fetched cross-origin by the dashboard (<img src>), so allow that.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Explicit JSON / form body cap (413 above it); multipart uploads are capped per route.
  express.useBodyParser('json', { limit: env.BODY_LIMIT });
  express.useBodyParser('urlencoded', { limit: env.BODY_LIMIT, extended: true });
  const origin = corsOrigin(env.CORS_ORIGINS);
  app.enableCors({
    origin,
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after', 'content-disposition'],
  });
  // Same allowlist for Socket.IO (the /admin gateway).
  app.useWebSocketAdapter(new CorsIoAdapter(app, origin));
  app.enableShutdownHooks();
}

export function corsOrigin(value: string): boolean | string[] {
  if (value.trim() === '*') {
    // Reflect the caller's origin: a literal "*" is not allowed with credentials.
    // Refused in production by validateEnv.
    return true;
  }
  return corsList(value);
}

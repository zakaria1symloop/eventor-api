import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext, type RequestContextStore } from './request-context.js';

export const REQUEST_ID_HEADER = 'x-request-id';
const VALID_INCOMING_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function newRequestId(): string {
  return `req_${randomBytes(4).toString('hex')}`;
}

/**
 * Gives every request an id (reusing a well-formed incoming `x-request-id`, as
 * Nginx may set one), echoes it in the response header, opens the request
 * context, and logs one line per request when it finishes: requestId, userId,
 * method, route, status, duration. Never bodies, headers or query strings, so
 * passwords, tokens and signed-URL signatures stay out of the logs.
 */
export function requestIdMiddleware(options: { log: boolean }) {
  const logger = new Logger('HTTP');

  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && VALID_INCOMING_ID.test(incoming) ? incoming : newRequestId();
    (req as Request & { id?: string }).id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const store: RequestContextStore = {
      requestId,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent')?.slice(0, 255) ?? null,
      userId: null,
      userRole: null,
    };

    if (options.log) {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const path = (req.originalUrl ?? req.url).split('?')[0];
        const route = (req.route as { path?: string } | undefined)?.path;
        // The matched route pattern (`/api/v1/files/:id`) keeps ids and signed-URL
        // parts out of the log; unmatched requests fall back to the bare path.
        const shown = route && !route.includes('*') ? `${req.baseUrl}${route}` : path;
        const line = `${requestId} ${store.userId ?? '-'} ${req.method} ${shown} ${res.statusCode} ${ms.toFixed(1)}ms`;
        if (res.statusCode >= 500) {
          logger.error(line);
        } else if (res.statusCode >= 400) {
          logger.warn(line);
        } else {
          logger.log(line);
        }
      });
    }

    runWithRequestContext(store, next);
  };
}

import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../errors/app.exception.js';
import { ERROR_CODES, isErrorCode, type ErrorCode } from '../errors/error-codes.js';
import { interpolate, resolveLanguage } from '../i18n/language.js';
import { getRequestId } from '../request-context/request-context.js';

/** The only error shape the API returns (api-standards §5). */
export interface ErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  details: unknown;
  path: string;
  timestamp: string;
  requestId: string | null;
}

const DEFAULT_CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'AUTH_TOKEN_INVALID',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  415: 'FILE_TYPE_NOT_ALLOWED',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Turns every thrown error into one JSON shape. AppExceptions carry their code;
 * Nest's built-in HTTP exceptions get a default code for their status; anything
 * else is a 500 with a generic message, logged in full with the request id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { statusCode, code, details } = this.describe(exception, request);
    const lang = resolveLanguage(request.headers['accept-language']);
    const definition = ERROR_CODES[code];

    const body: ErrorBody = {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      code,
      message: interpolate(definition[lang], details),
      details: details ?? null,
      path: request.originalUrl ?? request.url,
      timestamp: new Date().toISOString(),
      requestId: getRequestId() ?? (request as Request & { id?: string }).id ?? null,
    };

    if (statusCode >= 500) {
      this.logger.error(
        `[${body.requestId}] ${request.method} ${body.path} failed with ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const retryAfter = (details as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof retryAfter === 'number' && !response.headersSent) {
      response.setHeader('Retry-After', String(retryAfter));
    }

    if (!response.headersSent) {
      response.status(statusCode).json(body);
    }
  }

  private describe(
    exception: unknown,
    request: Request,
  ): { statusCode: number; code: ErrorCode; details: unknown } {
    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const payloadCode =
        typeof payload === 'object' && payload !== null
          ? (payload as { code?: unknown }).code
          : undefined;

      if (isErrorCode(payloadCode)) {
        return { statusCode, code: payloadCode, details: null };
      }
      if (statusCode === 404 && this.isUnknownRoute(payload, request)) {
        return { statusCode, code: 'ROUTE_NOT_FOUND', details: null };
      }
      // body-parser errors (malformed JSON, oversize body) arrive as HttpExceptions too.
      const code =
        DEFAULT_CODE_BY_STATUS[statusCode] ??
        (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
      return { statusCode, code, details: null };
    }

    const status = (exception as { status?: unknown; type?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Raw Express/body-parser errors (e.g. invalid JSON) carry a `status`.
      return {
        statusCode: status,
        code: DEFAULT_CODE_BY_STATUS[status] ?? 'BAD_REQUEST',
        details: null,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      details: null,
    };
  }

  private isUnknownRoute(payload: unknown, request: Request): boolean {
    const message =
      typeof payload === 'object' && payload !== null
        ? (payload as { message?: unknown }).message
        : payload;
    return (
      typeof message === 'string' &&
      message.startsWith(`Cannot ${request.method} `)
    );
  }
}

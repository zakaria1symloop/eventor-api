import { BadRequestException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AppException } from '../errors/app.exception.js';
import { flattenValidationErrors } from '../errors/validation.js';
import { ERROR_CODES } from '../errors/error-codes.js';
import { runWithRequestContext } from '../request-context/request-context.js';
import { AllExceptionsFilter, type ErrorBody } from './all-exceptions.filter.js';

function run(exception: unknown, headers: Record<string, string> = {}, url = '/api/v1/admin/categories/1') {
  const json = vi.fn();
  const response = { headersSent: false, status: vi.fn(() => ({ json })) };
  const request = { method: 'DELETE', originalUrl: url, url, headers };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  runWithRequestContext(
    { requestId: 'req_9f2a71c0', ip: null, userAgent: null, userId: null, userRole: null },
    () => new AllExceptionsFilter().catch(exception, host),
  );
  return { status: response.status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] as ErrorBody };
}

describe('AllExceptionsFilter', () => {
  it('returns the api-standards §5 shape for an AppException', () => {
    const { status, body } = run(new AppException(409, 'STALE_UPDATE', { updatedAt: '2026-09-15' }));
    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'STALE_UPDATE',
      message: ERROR_CODES.STALE_UPDATE.en,
      details: { updatedAt: '2026-09-15' },
      path: '/api/v1/admin/categories/1',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      requestId: 'req_9f2a71c0',
    });
  });

  it('translates the message with Accept-Language: ar and fills placeholders', () => {
    const { body } = run(new AppException(413, 'FILE_TOO_LARGE', { maxMb: 5 }), {
      'accept-language': 'ar',
    });
    expect(body.message).toBe('حجم الملف أكبر من 5 ميغابايت.');
    expect(body.code).toBe('FILE_TOO_LARGE');
  });

  it('falls back to English for unsupported languages', () => {
    const { body } = run(AppException.of('FILE_NOT_FOUND'), { 'accept-language': 'fr-FR,fr;q=0.9' });
    expect(body.message).toBe('The file was not found.');
  });

  it('keeps per-field details for validation failures', () => {
    const details = flattenValidationErrors([
      {
        property: 'email',
        constraints: { isEmail: 'email must be an email' },
        children: [],
      },
      {
        property: 'lines',
        children: [
          { property: '0', children: [{ property: 'label', constraints: { maxLength: 'too long' }, children: [] }] },
        ],
      },
    ]);
    const { status, body } = run(new AppException(400, 'VALIDATION_FAILED', details), {
      'accept-language': 'ar',
    });
    expect(status).toBe(400);
    expect(body.message).toBe('بعض الحقول غير صالحة.');
    expect(body.details).toEqual([
      { field: 'email', code: 'IS_EMAIL', message: 'email must be an email' },
      { field: 'lines.0.label', code: 'MAX_LENGTH', message: 'too long' },
    ]);
  });

  it('maps Nest HTTP exceptions to default codes', () => {
    expect(run(new BadRequestException('x')).body.code).toBe('BAD_REQUEST');
    expect(run(new ThrottlerException()).body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(run(new NotFoundException('Cannot DELETE /api/v1/nope')).body.code).toBe('ROUTE_NOT_FOUND');
    expect(run(new NotFoundException()).body.code).toBe('NOT_FOUND');
  });

  it('hides unexpected errors behind INTERNAL_ERROR', () => {
    const { status, body } = run(new Error('connection string leaked'));
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('leaked');
  });

  it('has an EN and AR message for every code', () => {
    for (const [code, definition] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(definition.en.length, code).toBeGreaterThan(0);
      expect(definition.ar.length, code).toBeGreaterThan(0);
    }
  });
});

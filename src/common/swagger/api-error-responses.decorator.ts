import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ERROR_CODES, type ErrorCode } from '../errors/error-codes.js';
import { STATUS_CODES } from 'node:http';

export class FieldErrorDto {
  @ApiProperty({ example: 'email' })
  field: string;

  @ApiProperty({ example: 'IS_EMAIL' })
  code: string;

  @ApiProperty({ example: 'email must be an email' })
  message: string;
}

/** The body of every error response (api-standards §5). */
export class ErrorResponseDto {
  @ApiProperty({ example: 409 })
  statusCode: number;

  @ApiProperty({ example: 'Conflict' })
  error: string;

  @ApiProperty({
    example: 'CATEGORY_HAS_SERVICES',
    description: 'Stable UPPER_SNAKE code clients switch on.',
    enum: Object.keys(ERROR_CODES),
  })
  code: string;

  @ApiProperty({
    example: 'This category still has 10 services.',
    description: 'Translated with Accept-Language (en | ar).',
  })
  message: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Extra data for the code. For VALIDATION_FAILED: an array of `{ field, code, message }`.',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: { $ref: getSchemaPath(FieldErrorDto) } },
    ],
    example: { servicesCount: 10 },
  })
  details: unknown;

  @ApiProperty({ example: '/api/v1/admin/categories/7c4a…' })
  path: string;

  @ApiProperty({ example: '2026-09-15T10:00:00.000Z', format: 'date-time' })
  timestamp: string;

  @ApiProperty({ type: String, example: 'req_9f2a71c0', nullable: true })
  requestId: string | null;
}

/**
 * Documents the error responses of an endpoint, grouped by status, listing
 * each code with its English message. 401/403 for guarded routes and 429 are
 * added by `ApiAuthErrors()` / globally; list the business codes here.
 *
 *   @ApiErrorResponses('VALIDATION_FAILED', 'CATEGORY_HAS_SERVICES')
 */
export function ApiErrorResponses(...codes: ErrorCode[]) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  return applyDecorators(
    ApiExtraModels(ErrorResponseDto, FieldErrorDto),
    ...[...byStatus.entries()].map(([status, statusCodes]) =>
      ApiResponse({
        status,
        description: statusCodes
          .map((code) => `\`${code}\`: ${ERROR_CODES[code].en}`)
          .join('<br>'),
        content: {
          'application/json': {
            schema: { $ref: getSchemaPath(ErrorResponseDto) },
            examples: Object.fromEntries(
              statusCodes.map((code) => [
                code,
                {
                  value: {
                    statusCode: status,
                    error: STATUS_CODES[status],
                    code,
                    message: ERROR_CODES[code].en,
                    details: null,
                    path: '/api/v1/…',
                    timestamp: '2026-09-15T10:00:00.000Z',
                    requestId: 'req_9f2a71c0',
                  },
                },
              ]),
            ),
          },
        },
      }),
    ),
  );
}

/** 401 + 403 codes produced by the global guards, for authenticated routes. */
export function ApiAuthErrors() {
  return ApiErrorResponses(
    'AUTH_TOKEN_MISSING',
    'AUTH_TOKEN_INVALID',
    'AUTH_TOKEN_EXPIRED',
    'FORBIDDEN_ROLE',
  );
}

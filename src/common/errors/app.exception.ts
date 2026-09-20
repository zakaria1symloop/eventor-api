import { HttpException, type HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from './error-codes.js';

/**
 * The exception services and guards throw. The filter turns it into the
 * standard error body with a translated message.
 *
 * `details` is returned to the client as-is (never put secrets in it) and fills
 * `{placeholders}` in the message.
 *
 *   throw new AppException(409, 'CATEGORY_HAS_SERVICES', { servicesCount: 10 });
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus | number,
    readonly code: ErrorCode,
    readonly details: unknown = null,
  ) {
    super({ code, message: ERROR_CODES[code].en, details }, status);
  }

  /** Throws with the code's default status. */
  static of(code: ErrorCode, details: unknown = null): AppException {
    return new AppException(ERROR_CODES[code].status, code, details);
  }
}

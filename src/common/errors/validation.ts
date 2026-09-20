import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { AppException } from './app.exception.js';

export interface FieldError {
  /** Dotted path, e.g. `lines.0.label`. */
  field: string;
  /** The failed constraint in UPPER_SNAKE, e.g. `IS_EMAIL`, `WHITELIST`. */
  code: string;
  message: string;
}

function toUpperSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

export function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([name, message]) => ({
      field,
      code: toUpperSnake(name),
      message,
    }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/** Global pipe: unknown fields are rejected; failures become 400 VALIDATION_FAILED. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppException(400, 'VALIDATION_FAILED', flattenValidationErrors(errors)),
  });
}

import { ParseIntPipe, ParseUUIDPipe } from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import type { ErrorCode } from '../errors/error-codes.js';

type TransformInput = { value: unknown };

/** Trims strings; other values pass through. */
export const trim = ({ value }: TransformInput): unknown => (typeof value === 'string' ? value.trim() : value);

/** Trims and turns an empty string into null (optional nullable text). */
export const trimToNull = ({ value }: TransformInput): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Repeated query parameters (`?level=a&level=b`) as an array; a single value becomes `[value]`. */
export const toArray = ({ value }: TransformInput): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  return Array.isArray(value) ? value : [value];
};

/** `'true' | 'false'` query strings to booleans. */
export const toBoolean = ({ value }: TransformInput): unknown => {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

/** `:id` param pipe that answers 404 with the resource's code for a malformed UUID. */
export const uuidParam = (code: ErrorCode) => new ParseUUIDPipe({ exceptionFactory: () => AppException.of(code) });

/** `:code` param pipe that answers 404 with the resource's code for a non-integer value. */
export const intParam = (code: ErrorCode) => new ParseIntPipe({ exceptionFactory: () => AppException.of(code) });

/** Escapes `%`, `_` and `\` for a LIKE pattern. */
export const likeContains = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

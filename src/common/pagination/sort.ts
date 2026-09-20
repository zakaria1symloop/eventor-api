import { AppException } from '../errors/app.exception.js';

export type SortDirection = 'ASC' | 'DESC';

/**
 * Turns `?sort=field:dir` into a TypeORM `order` object, accepting only the
 * fields an endpoint allows: a client can never sort by a column the endpoint
 * did not choose to expose.
 */
export function toOrder<F extends string>(
  sort: string | undefined,
  allowed: readonly F[],
  fallback: readonly [F, SortDirection],
): Record<string, SortDirection> {
  if (!sort) {
    return { [fallback[0]]: fallback[1] };
  }

  const [field = '', direction = ''] = sort.split(':');

  if (!allowed.includes(field as F)) {
    throw new AppException(400, 'SORT_FIELD_NOT_ALLOWED', { field, allowed });
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new AppException(400, 'VALIDATION_FAILED', [
      { field: 'sort', code: 'SORT_DIRECTION', message: 'Sort direction must be asc or desc' },
    ]);
  }

  return { [field]: direction === 'asc' ? 'ASC' : 'DESC' };
}

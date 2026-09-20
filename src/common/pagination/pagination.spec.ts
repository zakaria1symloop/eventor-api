import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import { paginate } from './paginated.js';
import { PaginationQueryDto } from './pagination-query.dto.js';
import { toOrder } from './sort.js';

describe('paginate', () => {
  it('reports page, size, total and page count', () => {
    expect(paginate(['a', 'b'], 116, { page: 2, limit: 10 })).toEqual({
      data: ['a', 'b'],
      meta: { page: 2, limit: 10, total: 116, totalPages: 12 },
    });
  });

  it('has zero pages when there is nothing to list', () => {
    expect(paginate([], 0, { page: 1, limit: 20 }).meta.totalPages).toBe(0);
  });
});

describe('toOrder', () => {
  const allowed = ['createdAt', 'fullName'] as const;

  it('uses the fallback when no sort is given', () => {
    expect(toOrder(undefined, allowed, ['createdAt', 'DESC'])).toEqual({
      createdAt: 'DESC',
    });
  });

  it('maps field:dir to a TypeORM order', () => {
    expect(toOrder('fullName:asc', allowed, ['createdAt', 'DESC'])).toEqual({
      fullName: 'ASC',
    });
  });

  it('rejects fields the endpoint does not allow', () => {
    expect(() =>
      toOrder('passwordHash:asc', allowed, ['createdAt', 'DESC']),
    ).toThrow(AppException);
  });
});

describe('PaginationQueryDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'query', metatype: PaginationQueryDto });

  it('defaults to the first page of 20', async () => {
    await expect(validate({})).resolves.toMatchObject({ page: 1, limit: 20 });
  });

  it('parses query strings into numbers', async () => {
    await expect(validate({ page: '3', limit: '50' })).resolves.toMatchObject({
      page: 3,
      limit: 50,
    });
  });

  it('refuses a page size above 100', async () => {
    await expect(validate({ limit: '500' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses a malformed sort', async () => {
    await expect(validate({ sort: 'createdAt' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

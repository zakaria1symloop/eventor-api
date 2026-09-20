import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  getSchemaPath,
} from '@nestjs/swagger';

export class PageMeta {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 2847 })
  total: number;

  @ApiProperty({ example: 143 })
  totalPages: number;
}

/** The envelope every list endpoint returns. */
export interface Paginated<T, C = never> {
  data: T[];
  meta: PageMeta & ([C] extends [never] ? unknown : { counts: C });
}

export function paginate<T>(
  data: T[],
  total: number,
  query: { page: number; limit: number },
): Paginated<T> {
  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

/** `paginate` plus tab counters in `meta.counts` (one grouped query per screen). */
export function paginateWithCounts<T, C>(
  data: T[],
  total: number,
  query: { page: number; limit: number },
  counts: C,
): Paginated<T, C> {
  const page = paginate(data, total, query);
  return { data: page.data, meta: { ...page.meta, counts } } as Paginated<T, C>;
}

/**
 * Documents a list endpoint's `{ data, meta }` response for Swagger and generated
 * clients. `counts` documents `meta.counts` (tab counters) when the list has them.
 */
export function ApiPaginatedResponse(model: Type<unknown>, options: { counts?: Type<unknown> } = {}) {
  const meta = options.counts
    ? {
        allOf: [
          { $ref: getSchemaPath(PageMeta) },
          {
            type: 'object',
            required: ['counts'],
            properties: { counts: { $ref: getSchemaPath(options.counts) } },
          },
        ],
      }
    : { $ref: getSchemaPath(PageMeta) };
  return applyDecorators(
    ApiExtraModels(PageMeta, model, ...(options.counts ? [options.counts] : [])),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta,
        },
      },
    }),
  );
}

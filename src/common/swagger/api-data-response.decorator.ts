import { applyDecorators, HttpStatus, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * Documents a `{ data: <model> }` response (or `{ data: <model>[] }` with
 * `isArray`), the envelope of single-object and action endpoints.
 */
export function ApiDataResponse(
  model: Type<unknown>,
  options: { status?: HttpStatus | number; isArray?: boolean; description?: string } = {},
) {
  const ref = { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: options.status ?? HttpStatus.OK,
      description: options.description ?? 'Success',
      schema: {
        type: 'object',
        required: ['data'],
        properties: { data: options.isArray ? { type: 'array', items: ref } : ref },
      },
    }),
  );
}

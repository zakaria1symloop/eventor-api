import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const OPENAPI_PUBLIC_EXTENSION = 'x-public';

/**
 * Opens a route (or controller) to callers without a token. Routes are private
 * by default. Also marks the operation in OpenAPI so it is documented without
 * the bearer requirement.
 */
export const Public = () =>
  applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), ApiExtension(OPENAPI_PUBLIC_EXTENSION, true));

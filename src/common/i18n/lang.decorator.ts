import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../auth/auth.types.js';
import { resolveLanguage, type Lang } from './language.js';

/**
 * The language of the current request: `Accept-Language` first, then the
 * signed-in user's `language` (attached by `JwtAuthGuard` as `req.userLanguage`
 * when known), then `en` (tech-decisions → Languages).
 *
 *   list(@ReqLang() lang: Lang) { … }
 */
export const ReqLang = createParamDecorator((_data: unknown, context: ExecutionContext): Lang => {
  const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  return resolveLanguage(request.headers['accept-language'], request.user?.language ?? null);
});

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../auth.types.js';

/** The verified token's user: `@CurrentUser() user: AuthUser`, or `@CurrentUser('id') id: string`. */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, context: ExecutionContext) => {
    const user = context.switchToHttp().getRequest<Request & { user?: AuthUser }>().user;
    return field ? user?.[field] : user;
  },
);

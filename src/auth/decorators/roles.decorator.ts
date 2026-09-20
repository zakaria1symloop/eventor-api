import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../common/enums/user.enums.js';

export const ROLES_KEY = 'auth:roles';

/** Restricts a route (or controller) to these roles. `/admin/**` controllers use `@Roles(UserRole.Admin)`. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

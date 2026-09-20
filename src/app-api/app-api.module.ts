import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AppAuthController } from './app-auth.controller.js';
import { AppAuthService } from './app-auth.service.js';
import { AppBudgetService } from './app-budget.service.js';
import { AppCatalogController } from './app-catalog.controller.js';
import { AppCatalogService } from './app-catalog.service.js';
import { AppConfigController } from './app-config.controller.js';
import { AppFavouritesService } from './app-favourites.service.js';
import { AppMailListener } from './app-mail.listener.js';
import { AppMeController } from './app-me.controller.js';
import { AppMeService } from './app-me.service.js';

/**
 * Module 15, part 1: the mobile app API under `/api/v1/app/**`.
 *
 * Deliberately a separate module from the admin ones rather than extra routes
 * on them: the two surfaces have different audiences (`app` vs `dashboard`,
 * enforced by `JwtAuthGuard`), different response shapes (localised, privacy
 * -stripped) and different rate limits. The business rules are not duplicated —
 * visibility comes from `services.policy.ts` / `packs.policy.ts`, verification
 * from `verification.policy.ts`, and account deletion from `UserAccountsService`.
 */
@Module({
  imports: [UsersModule],
  controllers: [AppAuthController, AppMeController, AppCatalogController, AppConfigController],
  providers: [AppAuthService, AppMeService, AppCatalogService, AppFavouritesService, AppBudgetService, AppMailListener],
  exports: [AppMeService],
})
export class AppApiModule {}

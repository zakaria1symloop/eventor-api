import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { DisputesModule } from '../disputes/disputes.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { AppReviewsController } from './app-reviews.controller.js';
import { AppReviewsService } from './app-reviews.service.js';
import { PacksModule } from '../packs/packs.module.js';
import { AppGateway } from './app.gateway.js';
import { AppChatPushListener } from './app-chat-push.listener.js';
import { AppMessagesController } from './app-messages.controller.js';
import { AppMessagesService } from './app-messages.service.js';
import { ServicesModule } from '../services/services.module.js';
import { AppProviderController } from './app-provider.controller.js';
import { AppProviderService } from './app-provider.service.js';
import { UsersModule } from '../users/users.module.js';
import { AppBookingsController } from './app-bookings.controller.js';
import { AppBookingsService } from './app-bookings.service.js';
import { AppAuthController } from './app-auth.controller.js';
import { AppAuthService } from './app-auth.service.js';
import { AppBudgetService } from './app-budget.service.js';
import { AppCatalogController } from './app-catalog.controller.js';
import { AppCatalogService } from './app-catalog.service.js';
import { AppConfigController } from './app-config.controller.js';
import { AppFavouritesService } from './app-favourites.service.js';
import { AppMailListener } from './app-mail.listener.js';
import { AppAcademicController } from './app-academic.controller.js';
import { AppAcademicService } from './app-academic.service.js';
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
  imports: [UsersModule, BookingsModule, ServicesModule, PacksModule, MessagingModule, ReviewsModule, DisputesModule],
  controllers: [
    AppAuthController,
    AppMeController,
    AppAcademicController,
    AppCatalogController,
    AppConfigController,
    AppBookingsController,
    AppProviderController,
    AppMessagesController,
    AppReviewsController,
  ],
  providers: [
    AppAuthService,
    AppMeService,
    AppAcademicService,
    AppCatalogService,
    AppFavouritesService,
    AppBudgetService,
    AppMailListener,
    AppBookingsService,
    AppProviderService,
    AppMessagesService,
    AppReviewsService,
    AppGateway,
    AppChatPushListener,
  ],
  exports: [AppMeService],
})
export class AppApiModule {}

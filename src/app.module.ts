import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AcademicModule } from './academic/academic.module.js';
import { ActivityLogModule } from './activity-log/activity-log.module.js';
import { AdminsModule } from './admins/admins.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { DisputesModule } from './disputes/disputes.module.js';
import { EventsModule } from './common/events/events.module.js';
import { createValidationPipe } from './common/errors/validation.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { envConfig, type Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { FilesModule } from './files/files.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PacksModule } from './packs/packs.module.js';
import { PushModule } from './push/push.module.js';
import { ServicesModule } from './services/services.module.js';
import { QueueModule } from './queue/queue.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { SavedViewsModule } from './saved-views/saved-views.module.js';
import { SequencesModule } from './sequences/sequences.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { StatsModule } from './stats/stats.module.js';
import { UsersModule } from './users/users.module.js';
import { VerificationModule } from './verification/verification.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, load: [envConfig] }),
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [envConfig.KEY],
      useFactory: (env: Env) => [{ ttl: env.THROTTLE_TTL_MS, limit: env.THROTTLE_LIMIT }],
    }),
    DatabaseModule,
    EventsModule,
    QueueModule,
    AuditModule,
    SettingsModule,
    SequencesModule,
    AuthModule,
    MailModule,
    PushModule,
    NotificationsModule,
    FilesModule,
    HealthModule,
    AdminsModule,
    ExportsModule,
    ActivityLogModule,
    SavedViewsModule,
    CatalogModule,
    UsersModule,
    VerificationModule,
    PacksModule,
    ServicesModule,
    MessagingModule,
    BookingsModule,
    DisputesModule,
    AcademicModule,
    ReviewsModule,
    StatsModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}

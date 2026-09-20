import { Global, Module } from '@nestjs/common';
import { AdminAlertsService } from './admin-alerts.service.js';
import { AdminNotificationsController } from './admin-notifications.controller.js';
import { AdminNotificationsService } from './admin-notifications.service.js';
import { NotificationsService } from './notifications.service.js';

/** In-app notification rows + push (global, used by every module's listeners) and the admin notification panel (SHL-02). */
@Global()
@Module({
  controllers: [AdminNotificationsController],
  providers: [NotificationsService, AdminNotificationsService, AdminAlertsService],
  exports: [NotificationsService, AdminNotificationsService],
})
export class NotificationsModule {}

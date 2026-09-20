import { Module } from '@nestjs/common';
import { AdminAdminsController } from './admin-admins.controller.js';
import { AdminMeController } from './admin-me.controller.js';
import { AdminsService } from './admins.service.js';

/** Module 1: my account and the admin team. Auth itself lives in AuthModule. */
@Module({
  controllers: [AdminMeController, AdminAdminsController],
  providers: [AdminsService],
})
export class AdminsModule {}

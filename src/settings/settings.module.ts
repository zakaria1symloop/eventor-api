import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from '../admin/entities/setting.entity.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminSettingsService } from './admin-settings.service.js';
import { SettingsService } from './settings.service.js';

/** Typed settings for every module (global) and the SET-01 admin endpoints (module 2). */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting])],
  controllers: [AdminSettingsController],
  providers: [SettingsService, AdminSettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}

import { Module } from '@nestjs/common';
import { AdminSavedViewsController } from './admin-saved-views.controller.js';
import { SavedViewsService } from './saved-views.service.js';

/** Module 2: saved list views. */
@Module({
  controllers: [AdminSavedViewsController],
  providers: [SavedViewsService],
})
export class SavedViewsModule {}

import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { QueueService } from './queue.service.js';

/**
 * Background jobs (QueueService) and cron (`@nestjs/schedule`). Cron methods
 * (`@Cron`) should only enqueue jobs, so the work gets retries and one place
 * to look for failures.
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}

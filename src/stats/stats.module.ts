import { Module } from '@nestjs/common';
import { AdminOverviewController } from './admin-overview.controller.js';
import { OverviewService } from './overview.service.js';
import { SearchService } from './search.service.js';

/** Module 13: overview aggregates + nightly `stats_daily` rollup, sidebar counters and global search (OVR-01, SHL-01). Admin notifications (SHL-02) live in NotificationsModule. */
@Module({
  controllers: [AdminOverviewController],
  providers: [OverviewService, SearchService],
  exports: [OverviewService],
})
export class StatsModule {}

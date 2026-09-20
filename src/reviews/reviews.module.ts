import { Module, type OnModuleInit } from '@nestjs/common';
import { DisputesModule } from '../disputes/disputes.module.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { AdminMessageReportsController, AdminReportsController } from './admin-reports.controller.js';
import { AdminReviewRepliesController, AdminReviewsController } from './admin-reviews.controller.js';
import { ReportFiltersDto, type ReportRowDto } from './dto/reports.dto.js';
import { ReviewFiltersDto } from './dto/reviews.dto.js';
import { ReportsService } from './reports.service.js';
import { ReviewsListener } from './reviews.listener.js';
import { ReviewsService } from './reviews.service.js';

/** Module 12: reviews, provider replies and reports (REV-01…REV-03, report actions for MSG-01). */
@Module({
  imports: [DisputesModule],
  controllers: [AdminReviewsController, AdminReviewRepliesController, AdminReportsController, AdminMessageReportsController],
  providers: [ReviewsService, ReportsService, ReviewsListener],
  exports: [ReviewsService, ReportsService],
})
export class ReviewsModule implements OnModuleInit {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly reports: ReportsService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    type ReviewExportRow = Awaited<ReturnType<ReviewsService['exportRows']>>[number];
    this.exports.register<ReviewFiltersDto, ReviewExportRow>({
      resource: 'reviews',
      screens: 'REV-01',
      filters: ReviewFiltersDto,
      columns: [
        { key: 'id', header: 'Review id', value: (r) => r.id },
        { key: 'createdAt', header: 'Created (UTC)', value: (r) => r.createdAt },
        { key: 'rating', header: 'Rating', value: (r) => r.rating },
        { key: 'status', header: 'Status', value: (r) => r.status },
        { key: 'comment', header: 'Comment', value: (r) => r.fullComment },
        { key: 'redactedComment', header: 'Redacted comment', value: (r) => r.redactedComment },
        { key: 'author', header: 'Author', value: (r) => r.author.fullName },
        { key: 'provider', header: 'Provider', value: (r) => r.provider.businessName ?? r.provider.fullName },
        { key: 'service', header: 'Service / pack', value: (r) => r.service?.titleEn ?? r.pack?.nameEn ?? null },
        { key: 'booking', header: 'Booking', value: (r) => r.booking.reference },
        { key: 'hadDispute', header: 'Had dispute', value: (r) => r.hadDispute },
        { key: 'detectedFlags', header: 'Detected flags', value: (r) => r.detectedFlags.join(', ') },
        { key: 'reportsOpen', header: 'Open reports', value: (r) => r.reportsOpen },
        { key: 'reply', header: 'Provider reply', value: (r) => r.reply?.body ?? null },
        { key: 'replyStatus', header: 'Reply status', value: (r) => r.reply?.status ?? null },
      ],
      defaultColumns: ['createdAt', 'rating', 'status', 'comment', 'author', 'provider', 'service', 'booking', 'reportsOpen'],
      count: (filters) => this.reviews.count(filters),
      fetch: (filters, page) => this.reviews.exportRows(filters, page),
    });

    this.exports.register<ReportFiltersDto, ReportRowDto>({
      resource: 'reports',
      screens: 'REV-01, MSG-01',
      filters: ReportFiltersDto,
      columns: [
        { key: 'id', header: 'Report id', value: (r) => r.id },
        { key: 'createdAt', header: 'Created (UTC)', value: (r) => r.createdAt },
        { key: 'status', header: 'Status', value: (r) => r.status },
        { key: 'targetType', header: 'Target type', value: (r) => r.targetType },
        { key: 'target', header: 'Target', value: (r) => r.target.label },
        { key: 'booking', header: 'Booking', value: (r) => r.target.bookingReference },
        { key: 'reason', header: 'Reason', value: (r) => r.reason },
        { key: 'note', header: 'Note', value: (r) => r.note },
        { key: 'reporter', header: 'Reporter', value: (r) => r.reporter?.fullName ?? 'Automatic' },
        { key: 'resolvedBy', header: 'Resolved by', value: (r) => r.resolvedBy?.fullName ?? null },
        { key: 'resolvedAt', header: 'Resolved (UTC)', value: (r) => r.resolvedAt },
        { key: 'resolutionNote', header: 'Resolution note', value: (r) => r.resolutionNote },
        { key: 'dispute', header: 'Dispute', value: (r) => r.disputeReference },
      ],
      defaultColumns: ['createdAt', 'status', 'targetType', 'target', 'reason', 'reporter', 'resolvedBy', 'resolvedAt'],
      count: (filters) => this.reports.count(filters),
      fetch: (filters, page) => this.reports.fetchRows(filters, undefined, page),
    });
  }
}

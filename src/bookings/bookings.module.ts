import { Module, type OnModuleInit } from '@nestjs/common';
import { ExportRegistry } from '../exports/export-registry.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { AdminBookingsController } from './admin-bookings.controller.js';
import { BookingJobsService } from './booking-jobs.service.js';
import { BookingsMailListener } from './bookings-mail.listener.js';
import { BookingsService } from './bookings.service.js';
import { BookingFiltersDto, type BookingRowDto } from './dto/bookings.dto.js';
import { InvoicesService } from './invoices.service.js';

/** Module 8: bookings, invoices and booking jobs (BKG-01…BKG-07). BookingsService is shared with users, services and packs. */
@Module({
  imports: [MessagingModule],
  controllers: [AdminBookingsController],
  providers: [BookingsService, InvoicesService, BookingJobsService, BookingsMailListener],
  exports: [BookingsService, InvoicesService, BookingJobsService],
})
export class BookingsModule implements OnModuleInit {
  constructor(
    private readonly bookings: BookingsService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<BookingFiltersDto, BookingRowDto>({
      resource: 'bookings',
      screens: 'BKG-01',
      filters: BookingFiltersDto,
      columns: [
        { key: 'reference', header: 'Reference', value: (b) => b.reference },
        { key: 'status', header: 'Status', value: (b) => b.status },
        { key: 'disputeStatus', header: 'Dispute', value: (b) => b.disputeStatus },
        { key: 'noReply', header: 'No reply', value: (b) => b.noReply },
        { key: 'client', header: 'Client', value: (b) => b.client.fullName },
        { key: 'provider', header: 'Provider', value: (b) => b.provider.fullName },
        { key: 'businessName', header: 'Business name', value: (b) => b.provider.businessName },
        { key: 'service', header: 'Service / pack', value: (b) => b.service?.titleEn ?? b.pack?.nameEn ?? null },
        { key: 'eventType', header: 'Event type', value: (b) => b.eventType },
        { key: 'eventDate', header: 'Event date', value: (b) => b.eventDate },
        { key: 'startTime', header: 'Start', value: (b) => b.startTime },
        { key: 'endTime', header: 'End', value: (b) => b.endTime },
        { key: 'wilaya', header: 'Wilaya', value: (b) => `${b.wilaya.code} ${b.wilaya.name}` },
        { key: 'guests', header: 'Guests', value: (b) => b.guests },
        { key: 'total', header: 'Total (DZD)', value: (b) => b.total },
        { key: 'source', header: 'Source', value: (b) => b.source },
        { key: 'respondedAt', header: 'Responded (UTC)', value: (b) => b.respondedAt },
        { key: 'createdAt', header: 'Created (UTC)', value: (b) => b.createdAt },
      ],
      defaultColumns: ['reference', 'status', 'client', 'provider', 'service', 'eventDate', 'wilaya', 'total', 'createdAt'],
      count: (filters) => this.bookings.count(filters),
      fetch: (filters, page) => this.bookings.fetchRows(filters, undefined, page),
    });
  }
}

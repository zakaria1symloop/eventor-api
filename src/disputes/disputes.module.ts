import { Module, type OnModuleInit } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { AdminDisputesController } from './admin-disputes.controller.js';
import { DisputesListener } from './disputes.listener.js';
import { DisputesService } from './disputes.service.js';
import { DisputeFiltersDto, type DisputeRowDto } from './dto/disputes.dto.js';

/** Module 9: disputes (DSP-01…DSP-03). The booking freeze itself lives in the booking jobs (`dispute_status=open`). */
@Module({
  imports: [BookingsModule, MessagingModule],
  controllers: [AdminDisputesController],
  providers: [DisputesService, DisputesListener],
  exports: [DisputesService],
})
export class DisputesModule implements OnModuleInit {
  constructor(
    private readonly disputes: DisputesService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<DisputeFiltersDto, DisputeRowDto>({
      resource: 'disputes',
      screens: 'DSP-01',
      filters: DisputeFiltersDto,
      columns: [
        { key: 'reference', header: 'Reference', value: (d) => d.reference },
        { key: 'status', header: 'Status', value: (d) => d.status },
        { key: 'type', header: 'Type', value: (d) => d.type },
        { key: 'booking', header: 'Booking', value: (d) => d.booking.reference },
        { key: 'service', header: 'Service / pack', value: (d) => d.booking.titleEn },
        { key: 'eventDate', header: 'Event date', value: (d) => d.booking.eventDate },
        { key: 'openedBy', header: 'Opened by', value: (d) => d.openedBy.fullName },
        { key: 'openedByRole', header: 'Opened by role', value: (d) => d.openedBy.role },
        { key: 'against', header: 'Against', value: (d) => d.against.fullName },
        { key: 'assignedAdmin', header: 'Assigned admin', value: (d) => d.assignedAdmin?.fullName ?? null },
        { key: 'evidenceCount', header: 'Evidence', value: (d) => d.evidenceCount },
        { key: 'lastActivityAt', header: 'Last activity (UTC)', value: (d) => d.lastActivityAt },
        { key: 'createdAt', header: 'Opened (UTC)', value: (d) => d.createdAt },
      ],
      defaultColumns: ['reference', 'status', 'type', 'booking', 'openedBy', 'against', 'assignedAdmin', 'createdAt'],
      count: (filters) => this.disputes.count(filters),
      fetch: (filters, page) => this.disputes.fetchRows(filters, undefined, page),
    });
  }
}

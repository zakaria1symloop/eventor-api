import { Module, type OnModuleInit } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { AcademicMailListener } from './academic-mail.listener.js';
import { AcademicRequestsService } from './academic-requests.service.js';
import { AdminAcademicRequestsController } from './admin-academic-requests.controller.js';
import { AdminFormsController } from './admin-forms.controller.js';
import { AcademicRequestFiltersDto, type AcademicRequestRowDto } from './dto/academic-requests.dto.js';
import { FormFiltersDto, type FormRowDto } from './dto/forms.dto.js';
import { FormsService } from './forms.service.js';
import { PublicFormsController } from './public-forms.controller.js';
import { PublicFormsService } from './public-forms.service.js';

/** Module 10: academic requests and dynamic forms (ACR-01…ACR-07). Academic is not a role: anyone can submit a public form. */
@Module({
  imports: [BookingsModule, MessagingModule],
  controllers: [AdminFormsController, AdminAcademicRequestsController, PublicFormsController],
  providers: [FormsService, PublicFormsService, AcademicRequestsService, AcademicMailListener],
  exports: [AcademicRequestsService, FormsService],
})
export class AcademicModule implements OnModuleInit {
  constructor(
    private readonly requests: AcademicRequestsService,
    private readonly forms: FormsService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<AcademicRequestFiltersDto, AcademicRequestRowDto>({
      resource: 'academic-requests',
      screens: 'ACR-01',
      filters: AcademicRequestFiltersDto,
      columns: [
        { key: 'reference', header: 'Reference', value: (r) => r.reference },
        { key: 'status', header: 'Status', value: (r) => r.status },
        { key: 'title', header: 'Title', value: (r) => r.title },
        { key: 'institution', header: 'Institution', value: (r) => r.institutionName },
        { key: 'requesterName', header: 'Requester', value: (r) => r.requester.name },
        { key: 'requesterEmail', header: 'Email', value: (r) => r.requester.email },
        { key: 'requesterPhone', header: 'Phone', value: (r) => r.requester.phone },
        { key: 'eventType', header: 'Event type', value: (r) => r.eventType },
        { key: 'eventDate', header: 'Event date', value: (r) => r.eventDate },
        { key: 'wilaya', header: 'Wilaya', value: (r) => (r.wilaya ? `${r.wilaya.code} ${r.wilaya.name}` : null) },
        { key: 'attendees', header: 'Attendees', value: (r) => r.attendees },
        { key: 'budgetMin', header: 'Budget min (DZD)', value: (r) => r.budgetMin },
        { key: 'budgetMax', header: 'Budget max (DZD)', value: (r) => r.budgetMax },
        { key: 'form', header: 'Form', value: (r) => `${r.form.nameEn} v${r.form.version}` },
        { key: 'assignedAdmin', header: 'Assigned to', value: (r) => r.assignedAdmin?.fullName ?? null },
        { key: 'proposalsCount', header: 'Proposals', value: (r) => r.proposalsCount },
        { key: 'bookingsCount', header: 'Bookings', value: (r) => r.bookingsCount },
        { key: 'submittedAt', header: 'Submitted (UTC)', value: (r) => r.submittedAt },
      ],
      defaultColumns: ['reference', 'status', 'title', 'institution', 'requesterName', 'eventDate', 'wilaya', 'attendees', 'submittedAt'],
      count: (filters) => this.requests.count(filters),
      fetch: (filters, page) => this.requests.fetchRows(filters, undefined, page),
    });
    this.exports.register<FormFiltersDto, FormRowDto>({
      resource: 'forms',
      screens: 'ACR-05',
      filters: FormFiltersDto,
      columns: [
        { key: 'nameEn', header: 'Name', value: (f) => f.nameEn },
        { key: 'nameAr', header: 'Name (AR)', value: (f) => f.nameAr },
        { key: 'slug', header: 'Slug', value: (f) => f.slug },
        { key: 'status', header: 'Status', value: (f) => f.status },
        { key: 'isDefault', header: 'Default', value: (f) => f.isDefault },
        { key: 'liveVersion', header: 'Live version', value: (f) => f.liveVersion?.version ?? null },
        { key: 'submissionsCount', header: 'Submissions', value: (f) => f.submissionsCount },
        { key: 'publicUrl', header: 'Public link', value: (f) => f.publicUrl },
        { key: 'updatedAt', header: 'Updated (UTC)', value: (f) => f.updatedAt },
      ],
      count: (filters) => this.forms.count(filters),
      fetch: (filters, page) => this.forms.fetchRows(filters, undefined, page),
    });
  }
}

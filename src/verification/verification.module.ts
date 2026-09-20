import { Module, type OnModuleInit } from '@nestjs/common';
import { ExportRegistry } from '../exports/export-registry.js';
import { AdminVerificationsController } from './admin-verifications.controller.js';
import { VerificationFiltersDto, type VerificationRowDto } from './dto/verification.dto.js';
import { VerificationMailListener } from './verification-mail.listener.js';
import { VerificationService } from './verification.service.js';

/** Module 5: provider verification (VER-01…VER-04). */
@Module({
  controllers: [AdminVerificationsController],
  providers: [VerificationService, VerificationMailListener],
  exports: [VerificationService],
})
export class VerificationModule implements OnModuleInit {
  constructor(
    private readonly verification: VerificationService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    const doc = (row: VerificationRowDto, index: number) => row.documents[index]?.status ?? 'missing';
    this.exports.register<VerificationFiltersDto, VerificationRowDto>({
      resource: 'verifications',
      screens: 'VER-01',
      filters: VerificationFiltersDto,
      columns: [
        { key: 'fullName', header: 'Name', value: (r) => r.user.fullName },
        { key: 'email', header: 'Email', value: (r) => r.user.email },
        { key: 'phone', header: 'Phone', value: (r) => r.user.phone },
        { key: 'businessName', header: 'Business name', value: (r) => r.businessName },
        { key: 'category', header: 'Category', value: (r) => r.category?.nameEn ?? null },
        { key: 'wilaya', header: 'Wilaya', value: (r) => (r.wilaya ? `${r.wilaya.code} ${r.wilaya.name}` : null) },
        { key: 'status', header: 'Queue status', value: (r) => r.status },
        { key: 'nationalId', header: 'National ID', value: (r) => doc(r, 0) },
        { key: 'commercialRegister', header: 'Commercial register / artisan card', value: (r) => doc(r, 1) },
        { key: 'taxCard', header: 'Tax card', value: (r) => doc(r, 2) },
        { key: 'submittedAt', header: 'Submitted (UTC)', value: (r) => r.submittedAt },
      ],
      count: (filters) => this.verification.tabbed(filters).getCount(),
      fetch: (filters, page) => this.verification.fetchRows(filters, undefined, page),
    });
  }
}

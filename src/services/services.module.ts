import { Module, type OnModuleInit } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { PacksModule } from '../packs/packs.module.js';
import { AdminAvailabilityController } from './admin-availability.controller.js';
import { AdminServicesController } from './admin-services.controller.js';
import { AvailabilityService } from './availability.service.js';
import { ServiceFiltersDto, type ServiceRowDto } from './dto/services.dto.js';
import { ServicesMailListener } from './services-mail.listener.js';
import { ServicesService } from './services.service.js';

/** Module 6: services and availability (SRV-01…SRV-06). */
@Module({
  imports: [PacksModule, BookingsModule],
  controllers: [AdminServicesController, AdminAvailabilityController],
  providers: [ServicesService, AvailabilityService, ServicesMailListener],
  exports: [ServicesService],
})
export class ServicesModule implements OnModuleInit {
  constructor(
    private readonly services: ServicesService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<ServiceFiltersDto, ServiceRowDto>({
      resource: 'services',
      screens: 'SRV-01',
      filters: ServiceFiltersDto,
      columns: [
        { key: 'titleEn', header: 'Title (EN)', value: (s) => s.titleEn },
        { key: 'titleAr', header: 'Title (AR)', value: (s) => s.titleAr },
        { key: 'category', header: 'Category', value: (s) => s.category.nameEn },
        { key: 'provider', header: 'Provider', value: (s) => s.provider.fullName },
        { key: 'businessName', header: 'Business name', value: (s) => s.provider.businessName },
        { key: 'basePrice', header: 'Base price (DZD)', value: (s) => s.basePrice },
        { key: 'priceType', header: 'Price type', value: (s) => s.priceType },
        { key: 'rating', header: 'Rating', value: (s) => s.rating },
        { key: 'ratingCount', header: 'Ratings', value: (s) => s.ratingCount },
        { key: 'bookingsCount', header: 'Bookings', value: (s) => s.bookingsCount },
        { key: 'status', header: 'Status', value: (s) => s.status },
        { key: 'isFeatured', header: 'Featured', value: (s) => s.isFeatured },
        { key: 'visibleInApp', header: 'Visible in app', value: (s) => s.visibleInApp },
        { key: 'wilayas', header: 'Wilayas', value: (s) => s.wilayas.map((w) => w.code).join(', ') },
        { key: 'createdAt', header: 'Created (UTC)', value: (s) => s.createdAt },
      ],
      defaultColumns: ['titleEn', 'category', 'provider', 'basePrice', 'priceType', 'rating', 'bookingsCount', 'status', 'createdAt'],
      count: (filters) => this.services.tabbed(filters).getCount(),
      fetch: (filters, page) => this.services.fetchRows(filters, undefined, page),
    });
  }
}

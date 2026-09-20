import { Module, type OnModuleInit } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ExportRegistry } from '../exports/export-registry.js';
import { AdminPacksController } from './admin-packs.controller.js';
import { PackFiltersDto, type PackRowDto } from './dto/packs.dto.js';
import { PackHealthService } from './pack-health.service.js';
import { PacksService } from './packs.service.js';

/** Module 7: Ready Packs of one provider's own services (PCK-01…PCK-03). PackHealthService is shared with services. */
@Module({
  imports: [BookingsModule],
  controllers: [AdminPacksController],
  providers: [PacksService, PackHealthService],
  exports: [PacksService, PackHealthService],
})
export class PacksModule implements OnModuleInit {
  constructor(
    private readonly packs: PacksService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<PackFiltersDto, PackRowDto>({
      resource: 'packs',
      screens: 'PCK-01',
      filters: PackFiltersDto,
      columns: [
        { key: 'nameEn', header: 'Name (EN)', value: (p) => p.nameEn },
        { key: 'nameAr', header: 'Name (AR)', value: (p) => p.nameAr },
        { key: 'provider', header: 'Provider', value: (p) => p.provider.fullName },
        { key: 'businessName', header: 'Business name', value: (p) => p.provider.businessName },
        { key: 'itemsCount', header: 'Items', value: (p) => p.itemsCount },
        { key: 'itemsSummary', header: 'Item categories', value: (p) => p.itemsSummary.map((c) => c.nameEn).join(' · ') },
        { key: 'price', header: 'Price (DZD)', value: (p) => p.price },
        { key: 'sumOfItems', header: 'Sum of items (DZD)', value: (p) => p.sumOfItems },
        { key: 'savings', header: 'Savings (DZD)', value: (p) => p.savings },
        { key: 'eventType', header: 'Event type', value: (p) => p.eventType },
        { key: 'wilaya', header: 'Wilaya', value: (p) => `${p.wilaya.code} ${p.wilaya.name}` },
        { key: 'rating', header: 'Rating', value: (p) => p.rating },
        { key: 'bookingsCount', header: 'Bookings', value: (p) => p.bookingsCount },
        { key: 'status', header: 'Status', value: (p) => p.status },
        { key: 'needsAttention', header: 'Needs attention', value: (p) => p.needsAttention },
        { key: 'visibleInApp', header: 'Visible in app', value: (p) => p.visibleInApp },
        { key: 'createdAt', header: 'Created (UTC)', value: (p) => p.createdAt },
      ],
      defaultColumns: ['nameEn', 'provider', 'itemsCount', 'price', 'savings', 'eventType', 'wilaya', 'status', 'needsAttention', 'createdAt'],
      count: (filters) => this.packs.tabbed(filters).getCount(),
      fetch: (filters, page) => this.packs.fetchRows(filters, undefined, page),
    });
  }
}

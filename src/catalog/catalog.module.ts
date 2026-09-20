import { Module, type OnModuleInit } from '@nestjs/common';
import { ExportRegistry } from '../exports/export-registry.js';
import { AdminCategoriesController } from './admin-categories.controller.js';
import { AdminLocationsController } from './admin-locations.controller.js';
import { CategoriesService } from './categories.service.js';
import { CategoryFiltersDto, type CategoryDto } from './dto/categories.dto.js';
import { WilayaFiltersDto, type WilayaDto } from './dto/locations.dto.js';
import { LocationsService } from './locations.service.js';
import { PublicCatalogController } from './public-catalog.controller.js';

/** Module 3: categories (CAT-01/02), wilayas and communes (LOC-01/02), public reference lists for the web form. */
@Module({
  controllers: [AdminCategoriesController, AdminLocationsController, PublicCatalogController],
  providers: [CategoriesService, LocationsService],
  exports: [CategoriesService, LocationsService],
})
export class CatalogModule implements OnModuleInit {
  constructor(
    private readonly categories: CategoriesService,
    private readonly locations: LocationsService,
    private readonly exports: ExportRegistry,
  ) {}

  onModuleInit(): void {
    this.exports.register<CategoryFiltersDto, CategoryDto>({
      resource: 'categories',
      screens: 'CAT-01',
      filters: CategoryFiltersDto,
      columns: [
        { key: 'position', header: 'Position', value: (c) => c.position },
        { key: 'slug', header: 'Slug', value: (c) => c.slug },
        { key: 'nameEn', header: 'Name (EN)', value: (c) => c.nameEn },
        { key: 'nameAr', header: 'Name (AR)', value: (c) => c.nameAr },
        { key: 'descriptionEn', header: 'Description (EN)', value: (c) => c.descriptionEn },
        { key: 'descriptionAr', header: 'Description (AR)', value: (c) => c.descriptionAr },
        { key: 'icon', header: 'Icon', value: (c) => c.icon },
        { key: 'isVisible', header: 'Shown in app', value: (c) => (c.isVisible ? 'yes' : 'no') },
        { key: 'servicesCount', header: 'Services', value: (c) => c.servicesCount },
        { key: 'providersCount', header: 'Providers', value: (c) => c.providersCount },
        { key: 'bookings30dCount', header: 'Bookings (30 days)', value: (c) => c.bookings30dCount },
        { key: 'missingTranslation', header: 'Missing translation', value: (c) => (c.missingTranslation ? 'yes' : 'no') },
        { key: 'createdAt', header: 'Created (UTC)', value: (c) => c.createdAt },
      ],
      defaultColumns: ['position', 'slug', 'nameEn', 'nameAr', 'isVisible', 'servicesCount', 'providersCount', 'bookings30dCount'],
      count: (filters) => this.categories.filtered(filters).getCount(),
      fetch: async (filters, page) =>
        this.categories.withCounts(
          await this.categories
            .filtered(filters)
            .orderBy('category.position', 'ASC')
            .addOrderBy('category.createdAt', 'ASC')
            .skip(page.offset)
            .take(page.limit)
            .getMany(),
        ),
    });

    this.exports.register<WilayaFiltersDto, WilayaDto>({
      resource: 'wilayas',
      screens: 'LOC-01',
      filters: WilayaFiltersDto,
      columns: [
        { key: 'code', header: 'Code', value: (w) => w.code },
        { key: 'name', header: 'Name', value: (w) => w.name },
        { key: 'nameAr', header: 'Name (AR)', value: (w) => w.nameAr },
        { key: 'region', header: 'Region', value: (w) => w.region },
        { key: 'isOpen', header: 'Open', value: (w) => (w.isOpen ? 'yes' : 'no') },
        { key: 'communesCount', header: 'Communes', value: (w) => w.communesCount },
        { key: 'providersCount', header: 'Providers', value: (w) => w.providersCount },
        { key: 'servicesCount', header: 'Services', value: (w) => w.servicesCount },
        { key: 'clientsCount', header: 'Clients', value: (w) => w.clientsCount },
      ],
      count: (filters) => this.locations.filteredWilayas(filters).getCount(),
      fetch: async (filters, page) =>
        this.locations.wilayasWithCounts(
          await this.locations.filteredWilayas(filters).orderBy('wilaya.code', 'ASC').skip(page.offset).take(page.limit).getMany(),
        ),
    });
  }
}

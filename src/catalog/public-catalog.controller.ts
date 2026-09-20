import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';

export class PublicCategoryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'photographie' }) slug: string;
  @ApiProperty({ example: 'Photography' }) nameEn: string;
  @ApiProperty({ example: 'التصوير', description: 'May be empty when not translated yet.' }) nameAr: string;
  @ApiProperty({ example: 'camera' }) icon: string;
  @ApiProperty({ example: 1 }) position: number;
}

export class PublicWilayaDto {
  @ApiProperty({ example: 16 }) code: number;
  @ApiProperty({ example: 'Alger' }) name: string;
  @ApiProperty({ example: 'الجزائر' }) nameAr: string;
}

/**
 * Reference lists for public pages (the academic request form's
 * `service_categories` and `wilaya` fields). No token; global rate limit per IP
 * (`THROTTLE_LIMIT`, 100/min); cacheable for 5 minutes.
 */
@ApiTags('public-catalog')
@Public()
@Controller('public')
export class PublicCatalogController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get('categories')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Visible categories', description: 'Public (no token). Categories shown in the app, by position. Used by ACR-07 (service_categories field).' })
  @ApiDataResponse(PublicCategoryDto, { isArray: true })
  @ApiErrorResponses('RATE_LIMITED')
  async categories() {
    const rows: any[] = await this.dataSource.query('SELECT id, slug, name_en, name_ar, icon, position FROM categories WHERE is_visible = 1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC');
    return { data: rows.map((r) => ({ id: r.id, slug: r.slug, nameEn: r.name_en, nameAr: r.name_ar, icon: r.icon, position: Number(r.position) })) };
  }

  @Get('wilayas')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Open wilayas', description: 'Public (no token). Wilayas open for bookings, by code. Used by ACR-07 (wilaya field).' })
  @ApiDataResponse(PublicWilayaDto, { isArray: true })
  @ApiErrorResponses('RATE_LIMITED')
  async wilayas() {
    const rows: any[] = await this.dataSource.query('SELECT code, name, name_ar FROM wilayas WHERE is_open = 1 ORDER BY code ASC');
    return { data: rows.map((r) => ({ code: Number(r.code), name: r.name, nameAr: r.name_ar })) };
  }
}

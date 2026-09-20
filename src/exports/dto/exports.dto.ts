import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ExportFormat, ExportStatus } from '../../common/enums/admin.enums.js';

/** PDF exists in the schema but is not produced for list exports. */
export const EXPORT_FORMATS = [ExportFormat.Csv, ExportFormat.Xlsx] as const;

export class CreateExportDto {
  @ApiProperty({ example: 'categories', maxLength: 40, description: 'A resource from `GET /admin/exports/resources`.' })
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z][a-z0-9-]*$/)
  resource: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { tab: 'hidden', q: 'photo' },
    description: "The list screen's current filters (same names as its query parameters, arrays for multi-values). Unknown filters return 400.",
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], example: ['slug', 'nameEn', 'nameAr', 'servicesCount'], description: 'Column keys, in file order. Defaults to the resource defaults.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  columns?: string[];

  @ApiProperty({ enum: EXPORT_FORMATS, example: ExportFormat.Xlsx })
  @IsIn(EXPORT_FORMATS)
  format: ExportFormat;
}

export class ExportDto {
  @ApiProperty({ format: 'uuid', example: '3f6c2a10-8d4b-4e7f-a1c2-9b8d7e6f5a41' })
  id: string;

  @ApiProperty({ example: 'categories' })
  resource: string;

  @ApiProperty({ enum: EXPORT_FORMATS, example: ExportFormat.Xlsx })
  format: ExportFormat;

  @ApiProperty({ enum: ExportStatus, example: ExportStatus.Done, description: '`done` right away below 5,000 rows; otherwise `queued` and emailed when ready.' })
  status: ExportStatus;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { tab: 'hidden' } })
  filters: Record<string, unknown>;

  @ApiProperty({ type: [String], example: ['slug', 'nameEn', 'nameAr'] })
  columns: string[];

  @ApiProperty({ type: Number, nullable: true, example: 12, description: 'Rows written (null until done).' })
  rowCount: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'http://localhost:3000/api/v1/files/9d1e…?exp=1789552455&sig=…',
    description: 'Signed download URL (expires after FILES_URL_TTL); fetch the export again for a fresh one. null until done.',
  })
  fileUrl: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  emailedAt: string | null;

  @ApiProperty({ type: String, nullable: true, example: null, description: 'Why the export failed.' })
  error: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-15T10:00:01.000Z' })
  updatedAt: string;
}

export class ExportColumnDto {
  @ApiProperty({ example: 'nameEn' })
  key: string;

  @ApiProperty({ example: 'Name (EN)' })
  header: string;

  @ApiProperty({ example: true })
  isDefault: boolean;
}

export class ExportResourceDto {
  @ApiProperty({ example: 'categories' })
  resource: string;

  @ApiProperty({ example: 'CAT-01' })
  screens: string;

  @ApiProperty({ type: [ExportColumnDto] })
  columns: ExportColumnDto[];
}

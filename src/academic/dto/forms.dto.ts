import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { FormStatus } from '../../common/enums/academic.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PersonRefDto } from '../../users/dto/users.dto.js';
import { FORM_TABS, SLUG_PATTERN, type FormTab } from '../academic.policy.js';

export const FORM_SORT_FIELDS = ['updatedAt', 'createdAt', 'nameEn', 'submissionsCount'] as const;

const SCHEMA_EXAMPLE = {
  fields: [
    { key: 'full_name', type: 'short_text', label_en: 'Full name', label_ar: 'الاسم الكامل', required: true, maps_to: 'requester_name' },
    { key: 'title', type: 'short_text', label_en: 'Event title', label_ar: 'عنوان المناسبة', required: true, maps_to: 'title' },
    { key: 'event_date', type: 'date', label_en: 'Event date', label_ar: 'تاريخ المناسبة', required: true, maps_to: 'event_date', validation: { minOffsetDays: 7 } },
  ],
};

const SCHEMA_DESCRIPTION =
  '`{ fields: [...] }`. Field: `key` (a-z0-9_, unique), `type` (short_text, long_text, number, email, phone, single_choice, multi_choice, dropdown, date, time_range, wilaya, ' +
  'service_categories, budget_range, file, section, info, consent), `label_en`, `label_ar`, `help_en?`, `help_ar?`, `required?`, `options?` [{value, label_en, label_ar}] (choice types), ' +
  '`validation?` (text: minLength, maxLength, pattern; number: min, max, integer; multi_choice / service_categories: minSelected, maxSelected; date: minOffsetDays, maxOffsetDays; ' +
  'budget_range: min, max; file: maxFiles ≤ 10, types ⊆ pdf/jpg/png, maxSizeMb), `showIf?` {field (earlier), equals | in | notEmpty}, `section?` (key of a section field), ' +
  '`maps_to?` once each: title, event_type, event_date, wilaya, attendees, institution_name, needs, budget, requester_name, requester_phone.';

// ── list ─────────────────────────────────────────────────────

export class FormFiltersDto {
  @ApiPropertyOptional({ enum: FORM_TABS, description: 'Default `all`.' })
  @IsOptional()
  @IsIn(FORM_TABS)
  tab?: FormTab;

  @ApiPropertyOptional({ example: 'event', maxLength: 120, description: 'Name (EN / AR) or slug contains.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class FormsQueryDto extends IntersectionType(PaginationQueryDto, FormFiltersDto) {}

export class FormTabCountsDto {
  @ApiProperty({ example: 4 }) all: number;
  @ApiProperty({ example: 1 }) draft: number;
  @ApiProperty({ example: 2 }) published: number;
  @ApiProperty({ example: 1 }) closed: number;
}

export class FormVersionRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 3 }) version: number;
  @ApiProperty({ example: '2026-09-01T10:00:00.000Z' }) publishedAt: string;
}

export class FormRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'event-request' }) slug: string;
  @ApiProperty({ example: 'Event request' }) nameEn: string;
  @ApiProperty({ example: 'طلب مناسبة' }) nameAr: string;
  @ApiProperty({ enum: FormStatus }) status: FormStatus;
  @ApiProperty({ example: true }) isDefault: boolean;
  @ApiProperty({ example: false }) requiresAuth: boolean;
  @ApiProperty({ type: FormVersionRefDto, nullable: true }) liveVersion: FormVersionRefDto | null;
  @ApiProperty({ example: 18 }) submissionsCount: number;
  @ApiProperty({ example: false, description: 'The draft schema differs from the live version.' }) hasDraftChanges: boolean;
  @ApiProperty({ example: 'http://localhost:3001/f/event-request', description: 'Public web form (ACR-07).' }) publicUrl: string;
  @ApiProperty({ example: '2026-06-01T09:00:00.000Z' }) createdAt: string;
  @ApiProperty({ example: '2026-09-01T10:00:00.000Z' }) updatedAt: string;
}

export class FormVersionSummaryDto extends FormVersionRefDto {
  @ApiProperty({ type: PersonRefDto, nullable: true }) publishedBy: PersonRefDto | null;
  @ApiProperty({ example: 12 }) submissionsCount: number;
}

export class FormVersionDto extends FormVersionSummaryDto {
  @ApiProperty({ format: 'uuid' }) formId: string;
  @ApiProperty({ type: 'object', additionalProperties: true, example: SCHEMA_EXAMPLE }) schema: Record<string, unknown>;
}

export class FormDetailDto extends FormRowDto {
  @ApiProperty({ type: String, nullable: true, example: 'Tell us about your event and we will propose providers.' }) descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'أخبرنا عن مناسبتك وسنقترح عليك مقدمي خدمات.' }) descriptionAr: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 3 }) maxSubmissionsPerEmailPerMonth: number | null;
  @ApiProperty({ example: 'Thank you. We will get back to you within 3 working days.' }) confirmationEn: string;
  @ApiProperty({ example: 'شكرًا. سنعود إليك خلال 3 أيام عمل.' }) confirmationAr: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true, example: SCHEMA_EXAMPLE }) draftSchema: Record<string, unknown> | null;
  @ApiProperty({ type: [FormVersionSummaryDto] }) versions: FormVersionSummaryDto[];
  @ApiProperty({ type: PersonRefDto, nullable: true }) createdBy: PersonRefDto | null;
}

// ── writes ───────────────────────────────────────────────────

export class CreateFormDto {
  @ApiProperty({ example: 'Scientific day / conference', maxLength: 160 }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) nameEn: string;
  @ApiProperty({ example: 'يوم علمي / مؤتمر', maxLength: 160 }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) nameAr: string;

  @ApiPropertyOptional({ example: 'scientific-day', maxLength: 80, description: 'Generated from nameEn when omitted (a suffix is added if taken).' })
  @IsOptional()
  @Transform(trim)
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase letters, digits and dashes' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @Transform(trimToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) descriptionEn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @Transform(trimToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) descriptionAr?: string | null;
}

export class UpdateFormDto {
  @ApiPropertyOptional({ example: 'Event request', maxLength: 160 }) @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) nameEn?: string;
  @ApiPropertyOptional({ example: 'طلب مناسبة', maxLength: 160 }) @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) nameAr?: string;

  @ApiPropertyOptional({ example: 'event-request', maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase letters, digits and dashes' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @Transform(trimToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) descriptionEn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @Transform(trimToNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) descriptionAr?: string | null;
  @ApiPropertyOptional({ example: false, description: 'Only an existing client account with the email can submit.' }) @IsOptional() @IsBoolean() requiresAuth?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 3, minimum: 1, maximum: 255, description: 'null = unlimited.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(255)
  maxSubmissionsPerEmailPerMonth?: number | null;

  @ApiPropertyOptional({ example: 'Thank you. We will get back to you within 3 working days.', maxLength: 2000 }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(2000) confirmationEn?: string;
  @ApiPropertyOptional({ example: 'شكرًا. سنعود إليك خلال 3 أيام عمل.', maxLength: 2000 }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(2000) confirmationAr?: string;
  @ApiPropertyOptional({ example: true, description: 'true makes this the only default form; false on the current default is refused (409 FORM_DEFAULT_REQUIRED).' }) @IsOptional() @IsBoolean() isDefault?: boolean;

  @ApiPropertyOptional({ example: '2026-09-01T10:00:00.000Z', description: 'Optimistic concurrency: the `updatedAt` last read (409 STALE_UPDATE).' })
  @IsOptional()
  @IsDateString()
  updatedAt?: string;
}

export class SaveDraftDto {
  @ApiProperty({ type: 'object', additionalProperties: true, example: SCHEMA_EXAMPLE, description: SCHEMA_DESCRIPTION })
  @IsObject()
  schema: Record<string, unknown>;

  @ApiPropertyOptional({ example: '2026-09-01T10:00:00.000Z', description: 'Optimistic concurrency (409 STALE_UPDATE).' })
  @IsOptional()
  @IsDateString()
  updatedAt?: string;
}

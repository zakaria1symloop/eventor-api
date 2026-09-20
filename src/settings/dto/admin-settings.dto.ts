import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { trimToNull } from '../../common/dto/transforms.js';
import { SETTING_SECTIONS, SETTING_TYPES, type SettingSection, type SettingType } from '../settings.registry.js';

const ANY_VALUE = {
  oneOf: [
    { type: 'number' },
    { type: 'boolean' },
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
    { type: 'object', additionalProperties: true },
  ],
};

export class UserSummaryDto {
  @ApiProperty({ format: 'uuid', example: '5b0d6c9e-4a51-4c3f-9d0e-2f6b8a7c1e24' })
  id: string;

  @ApiProperty({ example: 'Sara Meziane' })
  fullName: string;
}

export class SettingItemDto {
  @ApiProperty({ example: 'platform_fee_percent' })
  key: string;

  @ApiProperty({ ...ANY_VALUE, example: 10, description: 'Typed value: see `type`.' })
  value: unknown;

  @ApiProperty({ ...ANY_VALUE, example: 10 })
  defaultValue: unknown;

  @ApiProperty({ enum: SETTING_TYPES, example: 'decimal', description: '`enum_list`: array of `options`; `object`: invoice issuer fields.' })
  type: SettingType;

  @ApiProperty({ type: Number, nullable: true, example: 0 })
  min: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 50 })
  max: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null, description: 'Max string length or list size.' })
  maxLength: number | null;

  @ApiProperty({ type: [String], nullable: true, example: null })
  options: string[] | null;

  @ApiProperty({ example: true, description: 'Changing it needs `confirm: true` (SET-01 confirm dialog).' })
  sensitive: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-09-15T10:00:00.000Z', description: 'Send back in `expectedUpdatedAt`.' })
  updatedAt: string | null;

  @ApiProperty({ type: UserSummaryDto, nullable: true })
  updatedBy: UserSummaryDto | null;
}

export class SettingsSectionDto {
  @ApiProperty({ enum: SETTING_SECTIONS, example: 'commission' })
  key: SettingSection;

  @ApiProperty({ type: [SettingItemDto] })
  settings: SettingItemDto[];
}

export class SettingsDto {
  @ApiProperty({ type: [SettingsSectionDto], description: 'Every section, in screen order (`notifications` has no keys yet).' })
  sections: SettingsSectionDto[];
}

export class UpdateSettingsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { platform_fee_percent: 12, booking_reply_deadline_hours: 24 },
    description: 'Setting key → new value. Each value is checked against its type and range.',
  })
  @IsObject()
  values: Record<string, unknown>;

  @ApiPropertyOptional({ example: true, description: 'Required when a sensitive setting changes.' })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'New commission from October.', maxLength: 500 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', format: 'date-time', nullable: true },
    example: { platform_fee_percent: '2026-09-15T10:00:00.000Z' },
    description: 'Key → the `updatedAt` you loaded (null if it was never saved). A mismatch returns 409 STALE_UPDATE.',
  })
  @IsOptional()
  @IsObject()
  expectedUpdatedAt?: Record<string, string | null>;
}

export class SettingDiffDto {
  @ApiProperty({ example: 'platform_fee_percent' })
  key: string;

  @ApiProperty({ ...ANY_VALUE, example: 10 })
  old: unknown;

  @ApiProperty({ ...ANY_VALUE, example: 12 })
  new: unknown;
}


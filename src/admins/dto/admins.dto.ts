import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { normaliseEmail } from '../../auth/dto/admin-auth.dto.js';
import { PASSWORD_MAX_LENGTH } from '../../auth/password.policy.js';
import { Language } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'Sara Meziane', minLength: 2, maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ format: 'email', example: 'sara.meziane@eventor.dz', maxLength: 190 })
  @IsOptional()
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email?: string;

  @ApiPropertyOptional({ enum: Language, example: Language.Ar })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({ example: 'Admin12345!', description: 'Required when `email` changes.' })
  @IsOptional()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword?: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'Admin12345!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  @ApiProperty({ example: 'Sunflower42x', description: 'At least 10 characters with a letter and a digit.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword: string;
}

export class SessionDto {
  @ApiProperty({ format: 'uuid', example: '0b8e1c52-7a44-4f0e-9d7b-3c2a1f6e5d40' })
  id: string;

  @ApiProperty({ type: String, nullable: true, example: 'Chrome on Windows' })
  deviceLabel: string | null;

  @ApiProperty({ type: String, nullable: true, example: '41.111.24.8' })
  ip: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) …' })
  userAgent: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-09-15T10:00:00.000Z' })
  lastUsedAt: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-09-14T08:12:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: true, description: 'The session of this request.' })
  current: boolean;
}

export const ADMIN_LIST_STATUSES = ['active', 'invited'] as const;
export type AdminListStatus = (typeof ADMIN_LIST_STATUSES)[number];
export const ADMIN_SORT_FIELDS = ['fullName', 'email', 'lastActiveAt', 'createdAt'] as const;

export class AdminsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'sara', description: 'Search in name and email.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ADMIN_LIST_STATUSES })
  @IsOptional()
  @IsIn(ADMIN_LIST_STATUSES)
  status?: AdminListStatus;
}

export class AdminListItemDto {
  @ApiProperty({ format: 'uuid', example: '5b0d6c9e-4a51-4c3f-9d0e-2f6b8a7c1e24', description: 'User id, or the invitation id for `invited` rows.' })
  id: string;

  @ApiProperty({ example: 'Karim Benali' })
  fullName: string;

  @ApiProperty({ format: 'email', example: 'karim.benali@eventor.dz' })
  email: string;

  @ApiProperty({ enum: ADMIN_LIST_STATUSES, example: 'active' })
  status: AdminListStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-09-15T10:00:00.000Z' })
  lastActiveAt: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true, example: null })
  invitationId: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null })
  invitedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: null, description: 'Invitation expiry; may be in the past (resend it).' })
  expiresAt: string | null;

  @ApiProperty({ example: false })
  isCurrentUser: boolean;
}

export class CreateInvitationDto {
  @ApiProperty({ example: 'Karim Benali', minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ format: 'email', example: 'karim.benali@eventor.dz', maxLength: 190 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(190)
  email: string;
}

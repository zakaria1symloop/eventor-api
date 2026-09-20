import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { AcademicRequestStatus } from '../../common/enums/academic.enums.js';

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const ANSWERS_EXAMPLE = {
  full_name: 'Nadia Hamdi',
  phone: '0555123456',
  institution: "Université d'Alger 1",
  title: 'Science Day 2026',
  event_type: 'academic',
  event_date: '2026-11-12',
  wilaya: 16,
  attendees: 350,
  needs: ['7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c'],
  budget: { min: 150000, max: 400000 },
};

export class PublicFormDto {
  @ApiProperty({ example: 'event-request' }) slug: string;
  @ApiProperty({ example: 'Event request' }) nameEn: string;
  @ApiProperty({ example: 'طلب مناسبة' }) nameAr: string;
  @ApiProperty({ type: String, nullable: true }) descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true }) descriptionAr: string | null;
  @ApiProperty({ example: 3, description: 'Live version number; submissions are validated against it.' }) version: number;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The published schema `{ fields: [...] }`.' }) schema: Record<string, unknown>;
  @ApiProperty({ example: false }) requiresAuth: boolean;
  @ApiProperty({ type: Number, nullable: true, example: 3 }) maxSubmissionsPerEmailPerMonth: number | null;
  @ApiProperty({ example: 'Thank you. We will get back to you within 3 working days.' }) confirmationEn: string;
  @ApiProperty({ example: 'شكرًا. سنعود إليك خلال 3 أيام عمل.' }) confirmationAr: string;
  @ApiProperty({ example: 5, description: '`max_document_upload_mb`.' }) uploadMaxMb: number;
}

export class EmailCodeDto {
  @ApiProperty({ example: 'nadia.hamdi@univ-alger.dz', maxLength: 190 })
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(190)
  email: string;
}

export class EmailCodeResultDto {
  @ApiProperty({ example: 'nadia.hamdi@univ-alger.dz' }) email: string;
  @ApiProperty({ example: '2026-09-16T10:15:00.000Z' }) expiresAt: string;
  @ApiProperty({ example: 60 }) resendAfterSeconds: number;
}

export class UploadResultDto {
  @ApiProperty({ example: '3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f.2a1b3c.9f86d081884c7d65', description: 'Send it back in `uploads` within 1 hour.' }) uploadToken: string;
  @ApiProperty({ example: 'programme-science-day.pdf' }) fileName: string;
  @ApiProperty({ example: 'application/pdf' }) mimeType: string;
  @ApiProperty({ example: 184233 }) sizeBytes: number;
  @ApiProperty({ example: '2026-09-16T11:00:00.000Z' }) expiresAt: string;
}

export class UploadRefDto {
  @ApiProperty({ example: 'programme' }) @IsString() @Matches(/^[a-z][a-z0-9_]{0,59}$/) fieldKey: string;
  @ApiProperty({ example: '3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f.2a1b3c.9f86d081884c7d65' }) @IsString() @MaxLength(200) uploadToken: string;
}

export class SubmitFormDto {
  @ApiProperty({ example: 'nadia.hamdi@univ-alger.dz', maxLength: 190 })
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(190)
  email: string;

  @ApiProperty({ example: '482913', description: 'The 6-digit code emailed by `POST …/email-code`.' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: ANSWERS_EXAMPLE, description: 'Answers by field key (file fields come from `uploads`).' })
  @IsObject()
  answers: Record<string, unknown>;

  @ApiPropertyOptional({ type: [UploadRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UploadRefDto)
  uploads?: UploadRefDto[];
}

export class SubmissionResultDto {
  @ApiProperty({ example: 'ACR-000142' }) reference: string;
  @ApiProperty({ enum: AcademicRequestStatus, example: 'pending' }) status: AcademicRequestStatus;
  @ApiProperty({ example: '2026-09-16T10:02:11.000Z' }) submittedAt: string;
  @ApiProperty({ example: 'Thank you. We will get back to you within 3 working days.' }) confirmationEn: string;
  @ApiProperty({ example: 'شكرًا. سنعود إليك خلال 3 أيام عمل.' }) confirmationAr: string;
}

export class EditAnswersDto {
  @ApiProperty({ type: 'object', additionalProperties: true, example: ANSWERS_EXAMPLE })
  @IsObject()
  answers: Record<string, unknown>;

  @ApiPropertyOptional({ type: [UploadRefDto], description: 'New files; file fields not sent keep their current files.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UploadRefDto)
  uploads?: UploadRefDto[];
}

export class RequestedChangesDto {
  @ApiProperty({ type: [String], example: ['event_date', 'attendees'] }) fields: string[];
  @ApiProperty({ example: 'Please confirm the date and the number of attendees.' }) message: string;
}

export class EditableRequestDto {
  @ApiProperty({ example: 'ACR-000142' }) reference: string;
  @ApiProperty({ enum: AcademicRequestStatus }) status: AcademicRequestStatus;
  @ApiProperty({ type: RequestedChangesDto }) requestedChanges: RequestedChangesDto;
  @ApiProperty({ example: 'Event request' }) formNameEn: string;
  @ApiProperty({ example: 'طلب مناسبة' }) formNameAr: string;
  @ApiProperty({ example: 2, description: 'The version the request was sent with (answers are validated against it).' }) version: number;
  @ApiProperty({ type: 'object', additionalProperties: true }) schema: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true, example: ANSWERS_EXAMPLE }) answers: Record<string, unknown>;
  @ApiProperty({ example: 'nadia.hamdi@univ-alger.dz' }) email: string;
  @ApiProperty({ example: '2026-09-30T10:00:00.000Z' }) linkExpiresAt: string;
}

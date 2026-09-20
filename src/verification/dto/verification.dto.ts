import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { toArray, trim } from '../../common/dto/transforms.js';
import { DocumentRejectReason, DocumentStatus, DocumentType } from '../../common/enums/file.enums.js';
import { Language, UserStatus, VerificationStatus } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { CategoryRefDto, DocumentProgressDto, DocumentSummaryItemDto, PersonRefDto, WilayaRefDto } from '../../users/dto/users.dto.js';
import { VERIFICATION_TABS, type VerificationRowStatus, type VerificationTab } from '../verification.policy.js';

export const VERIFICATION_SORT_FIELDS = ['submittedAt', 'fullName', 'createdAt'] as const;

const toIntArray = ({ value }: { value: unknown }) => {
  const list = toArray({ value });
  return Array.isArray(list) ? list.map((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v)) : list;
};

export class VerificationFiltersDto {
  @ApiPropertyOptional({
    enum: VERIFICATION_TABS,
    default: 'waiting',
    description:
      'Exclusive per provider: approved = verified; rejected = a current document rejected; resubmitted = a pending document replaces an older version; ' +
      'waiting = other pending documents; incomplete = nothing to review.',
  })
  @IsOptional()
  @IsIn(VERIFICATION_TABS)
  tab?: VerificationTab;

  @ApiPropertyOptional({ example: 'Studio', maxLength: 120, description: 'Name/email full-text, exact email or phone, business name.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  categoryId?: string;

  @ApiPropertyOptional({ type: [Number], example: [16], description: 'Wilaya codes; repeat for several.' })
  @IsOptional()
  @Transform(toIntArray)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(58, { each: true })
  wilaya?: number[];

  @ApiPropertyOptional({ enum: DocumentType, description: 'Has a current document of this type.' })
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @ApiPropertyOptional({ format: 'date', example: '2026-09-01', description: 'Latest submission on or after (UTC day).' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  submittedFrom?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-09-16', description: 'Latest submission on or before (UTC day, inclusive).' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  submittedTo?: string;
}

export class VerificationsQueryDto extends IntersectionType(PaginationQueryDto, VerificationFiltersDto) {}

/** Queue context for ‹ › navigation on VER-02: the list's filters and sort. */
export class VerificationNeighboursQueryDto extends VerificationFiltersDto {
  @ApiPropertyOptional({ example: 'submittedAt:asc' })
  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9]*:(asc|desc)$/, { message: 'sort must look like field:asc or field:desc' })
  sort?: string;
}

export class VerificationTabCountsDto {
  @ApiProperty({ example: 23 }) waiting: number;
  @ApiProperty({ example: 4 }) resubmitted: number;
  @ApiProperty({ example: 580 }) approved: number;
  @ApiProperty({ example: 9 }) rejected: number;
  @ApiProperty({ example: 21 }) incomplete: number;
  @ApiProperty({ example: 637 }) all: number;
}

export class VerificationUserDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Walid Saadi' }) fullName: string;
  @ApiProperty({ example: 'walid.saadi@gmail.com' }) email: string;
  @ApiProperty({ type: String, nullable: true, example: '+213661234567' }) phone: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
}

export class VerificationRowDto {
  @ApiProperty({ type: VerificationUserDto }) user: VerificationUserDto;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Pixel' }) businessName: string | null;
  @ApiProperty({ type: CategoryRefDto, nullable: true }) category: CategoryRefDto | null;
  @ApiProperty({ type: WilayaRefDto, nullable: true }) wilaya: WilayaRefDto | null;
  @ApiProperty({ type: [DocumentSummaryItemDto] }) documents: DocumentSummaryItemDto[];
  @ApiProperty({ type: DocumentProgressDto }) progress: DocumentProgressDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'Latest upload among current documents.' }) submittedAt: string | null;
  @ApiProperty({ enum: VERIFICATION_TABS.filter((t) => t !== 'all'), example: 'waiting' }) status: VerificationRowStatus;
  @ApiProperty({ enum: VerificationStatus }) verificationStatus: VerificationStatus;
}

export class DocumentDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: DocumentType }) type: DocumentType;
  @ApiProperty({ enum: DocumentStatus }) status: DocumentStatus;
  @ApiProperty({ example: true }) isCurrent: boolean;
  @ApiProperty({ description: 'Signed, expiring URL (FILES_URL_TTL).' }) viewUrl: string;
  @ApiProperty({ example: 'application/pdf' }) mimeType: string;
  @ApiProperty({ example: 184320 }) sizeBytes: number;
  @ApiProperty({ example: 'carte-identite.pdf' }) fileName: string;
  @ApiProperty({ format: 'date-time' }) uploadedAt: string;
  @ApiProperty({ enum: DocumentRejectReason, nullable: true }) rejectReason: DocumentRejectReason | null;
  @ApiProperty({ type: String, nullable: true }) rejectNote: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) reviewedBy: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) reviewedAt: string | null;
}

export class DocumentSlotDto {
  @ApiProperty({ enum: DocumentType }) type: DocumentType;
  @ApiProperty({ type: DocumentDto, nullable: true, description: 'null = missing.' }) current: DocumentDto | null;
  @ApiProperty({ type: [DocumentDto], description: 'Older versions, newest first (the previous decision).' }) previous: DocumentDto[];
}

export class VerificationAccountDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Walid Saadi' }) fullName: string;
  @ApiProperty({ example: 'walid.saadi@gmail.com' }) email: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) emailVerifiedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ enum: Language }) language: Language;
  @ApiProperty({ enum: UserStatus }) status: UserStatus;
  @ApiProperty({ type: String, nullable: true, example: 'Studio Pixel' }) businessName: string | null;
  @ApiProperty({ type: CategoryRefDto, nullable: true }) category: CategoryRefDto | null;
  @ApiProperty({ type: WilayaRefDto, nullable: true }) wilaya: WilayaRefDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class QueueNeighboursDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) prevUserId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextUserId: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 3, description: '1-based position in the queue; null when the provider is not in it.' }) position: number | null;
  @ApiProperty({ example: 23 }) total: number;
}

export class VerificationDetailDto {
  @ApiProperty({ enum: VerificationStatus }) verificationStatus: VerificationStatus;
  @ApiProperty({ enum: VERIFICATION_TABS.filter((t) => t !== 'all') }) status: VerificationRowStatus;
  @ApiProperty({ type: DocumentProgressDto }) progress: DocumentProgressDto;
  @ApiProperty({ type: [DocumentSlotDto] }) documents: DocumentSlotDto[];
  @ApiProperty({ type: VerificationAccountDto, description: '"Check against account" panel.' }) account: VerificationAccountDto;
  @ApiProperty({ type: QueueNeighboursDto }) neighbours: QueueNeighboursDto;
}

export class RejectDocumentDto {
  @ApiProperty({ enum: DocumentRejectReason, example: DocumentRejectReason.Unreadable })
  @IsEnum(DocumentRejectReason)
  reasonCode: DocumentRejectReason;

  @ApiProperty({ example: 'The photo is blurry; please upload a sharper scan of both sides.', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}

export class UploadDocumentDto {
  @ApiProperty({ enum: DocumentType })
  @IsEnum(DocumentType)
  type: DocumentType;
}

export class DocumentDecisionDto {
  @ApiProperty({ type: DocumentDto }) document: DocumentDto;
  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.Verified }) verificationStatus: VerificationStatus;
  @ApiProperty({ enum: VerificationStatus, example: VerificationStatus.Pending }) previousVerificationStatus: VerificationStatus;
  @ApiProperty({ type: DocumentProgressDto }) progress: DocumentProgressDto;
}

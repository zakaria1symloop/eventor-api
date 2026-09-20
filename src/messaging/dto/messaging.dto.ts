import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { toBoolean, trim, trimToNull } from '../../common/dto/transforms.js';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { ConversationClosedScope, ConversationKind, ConversationStatus, MessageKind, MessageStatus, ParticipantRole } from '../../common/enums/messaging.enums.js';
import { DisputeStatus, DisputeType, ReportReason } from '../../common/enums/moderation.enums.js';
import { UserRole } from '../../common/enums/user.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';
import { PersonRefDto } from '../../users/dto/users.dto.js';

export const CONVERSATION_SORT_FIELDS = ['lastMessageAt', 'createdAt'] as const;
export const CONTACT_KINDS = ['phone', 'email', 'url', 'handle'] as const;

// ── list ─────────────────────────────────────────────────────

export class ConversationFiltersDto {
  @ApiPropertyOptional({ enum: ConversationKind, description: 'MSG-01 chips: Disputes = `dispute`.' })
  @IsOptional()
  @IsEnum(ConversationKind)
  kind?: ConversationKind;

  @ApiPropertyOptional({ type: Boolean, description: 'Only conversations with open reports on their messages.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  reported?: boolean;

  @ApiPropertyOptional({ type: Boolean, description: 'Only conversations about a booking (`bookingId` set).' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  aboutBooking?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  bookingId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Conversations this user takes part in (USR-10/11 "View conversations").' })
  @IsOptional()
  @IsUUID('all')
  userId?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Unread by the current admin as support participant.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({ example: 'Amina', maxLength: 120, description: 'Participant name contains, or full-text on message text (words of 3+ letters).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class ConversationsQueryDto extends IntersectionType(PaginationQueryDto, ConversationFiltersDto) {}

export class ConversationCountsDto {
  @ApiProperty({ example: 412 }) all: number;
  @ApiProperty({ example: 3 }) reported: number;
  @ApiProperty({ example: 350 }) aboutBooking: number;
  @ApiProperty({ example: 4 }) disputes: number;
  @ApiProperty({ example: 7 }) unread: number;
}

export class ParticipantRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Amina Benali' }) fullName: string;
  @ApiProperty({ enum: ParticipantRole }) role: ParticipantRole;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
}

export class LastMessageDto {
  @ApiProperty({ type: String, nullable: true, example: 'Bonjour, vous êtes disponible le 20 décembre ?', description: 'Masked text, one line, 120 chars.' })
  bodyPreview: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ example: 'Amina Benali', description: '"Eventor support" for admins, "Eventor" for system messages.' }) senderName: string;
}

export class ConversationBookingRefDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-002041' }) reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
}

export class ConversationRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ConversationKind }) kind: ConversationKind;
  @ApiProperty({ type: [ParticipantRefDto] }) participants: ParticipantRefDto[];
  @ApiProperty({ type: LastMessageDto, nullable: true }) lastMessage: LastMessageDto | null;
  @ApiProperty({ example: 2, description: 'Messages newer than the current admin’s last read (0 when not a participant).' }) unreadCount: number;
  @ApiProperty({ type: ConversationBookingRefDto, nullable: true }) booking: ConversationBookingRefDto | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) disputeId: string | null;
  @ApiProperty({ enum: ConversationStatus }) status: ConversationStatus;
  @ApiProperty({ example: 0 }) reportsOpen: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastMessageAt: string | null;
}

// ── detail ───────────────────────────────────────────────────

export class ParticipantDetailDto extends ParticipantRefDto {
  @ApiProperty({ enum: UserRole }) userRole: UserRole;
  @ApiProperty({ example: 'amina.benali@gmail.com' }) email: string;
  @ApiProperty({ example: true }) canWrite: boolean;
  @ApiProperty({ example: false }) blocked: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastReadAt: string | null;
}

export class ConversationBookingCardDto extends ConversationBookingRefDto {
  @ApiProperty({ example: '2026-12-20' }) eventDate: string;
  @ApiProperty({ type: String, nullable: true, example: 'Wedding photo & video coverage' }) titleEn: string | null;
  @ApiProperty({ type: String, nullable: true }) titleAr: string | null;
  @ApiProperty({ example: '45000.00', description: 'DZD' }) total: string;
}

export class ConversationDisputeDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'DSP-000031' }) reference: string;
  @ApiProperty({ enum: DisputeStatus }) status: DisputeStatus;
  @ApiProperty({ enum: DisputeType }) type: DisputeType;
}

export class OpenReportDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) messageId: string;
  @ApiProperty({ enum: ReportReason }) reason: ReportReason;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: PersonRefDto }) reporter: PersonRefDto;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class ClosedInfoDto {
  @ApiProperty({ enum: ConversationClosedScope }) scope: ConversationClosedScope;
  @ApiProperty({ type: String, nullable: true, example: 'harassment' }) reason: string | null;
  @ApiProperty({ type: PersonRefDto, nullable: true }) closedBy: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) closedAt: string | null;
  @ApiProperty({ type: [String], description: 'Participants who can no longer write.' }) mutedUserIds: string[];
}

export class ConversationDetailDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ConversationKind }) kind: ConversationKind;
  @ApiProperty({ enum: ConversationStatus }) status: ConversationStatus;
  @ApiProperty({ type: [ParticipantDetailDto] }) participants: ParticipantDetailDto[];
  @ApiProperty({ type: ConversationBookingCardDto, nullable: true }) booking: ConversationBookingCardDto | null;
  @ApiProperty({ type: ConversationDisputeDto, nullable: true }) dispute: ConversationDisputeDto | null;
  @ApiProperty({ type: [OpenReportDto] }) reports: OpenReportDto[];
  @ApiProperty({ type: ClosedInfoDto, nullable: true }) closed: ClosedInfoDto | null;
  @ApiProperty({ example: false, description: 'Participants see original contact details (the pair has an accepted or completed booking).' }) contactUnmasked: boolean;
  @ApiProperty({ example: 0 }) unreadCount: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastMessageAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

// ── messages ─────────────────────────────────────────────────

export class MessagesQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Cursor: messages older than this message.' })
  @IsOptional()
  @IsUUID('all')
  before?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;
}

export class MessageSenderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Amina Benali' }) fullName: string;
  @ApiProperty({ enum: UserRole }) role: UserRole;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
}

export class ModerationInfoDto {
  @ApiProperty({ type: PersonRefDto, nullable: true }) by: PersonRefDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) at: string | null;
}

export class AdminMessageDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) conversationId: string;
  @ApiProperty({ enum: MessageKind }) kind: MessageKind;
  @ApiProperty({ type: MessageSenderDto, nullable: true, description: 'Null for system messages.' }) sender: MessageSenderDto | null;
  @ApiProperty({ example: 'Amina Benali', description: '"Eventor support" when an admin wrote it, "Eventor" for system messages.' }) senderLabel: string;
  @ApiProperty({ type: String, nullable: true, example: 'Appelez-moi au 0555 12 34 56', description: 'Original text (admins only).' }) body: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Appelez-moi au [phone hidden]', description: 'What participants see before an accepted booking; null when nothing is masked.' }) bodyMasked: string | null;
  @ApiProperty({ example: true }) masked: boolean;
  @ApiProperty({ enum: CONTACT_KINDS, isArray: true }) detectedContacts: (typeof CONTACT_KINDS)[number][];
  @ApiProperty({ enum: MessageStatus }) status: MessageStatus;
  @ApiProperty({ type: ModerationInfoDto, nullable: true }) moderation: ModerationInfoDto | null;
  @ApiProperty({ example: 0 }) reportsOpen: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) fileId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class MessagesPageMetaDto {
  @ApiProperty({ example: 30 }) limit: number;
  @ApiProperty({ example: true }) hasMore: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Pass as `before` for the previous page.' }) nextBefore: string | null;
}

export class MessagesPageDto {
  @ApiProperty({ type: [AdminMessageDto], description: 'Oldest first.' }) data: AdminMessageDto[];
  @ApiProperty({ type: MessagesPageMetaDto }) meta: MessagesPageMetaDto;
}

// ── writes ───────────────────────────────────────────────────

export class CreateConversationDto {
  @ApiProperty({ type: [String], format: 'uuid', example: ['3f1c9a2e-8b7d-4c6a-9e5f-2a1b3c4d5e6f'], description: 'Client or provider accounts (1–10).' })
  @IsUUID('all', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  userIds: string[];

  @ApiProperty({ example: 'Bonjour Amina, nous avons bien reçu votre signalement.', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  bookingId?: string;

  @ApiPropertyOptional({ description: 'Also email the message to each user. Default `false`.' })
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

export class SendMessageDto {
  @ApiProperty({ example: 'Merci, nous vérifions avec le prestataire.', maxLength: 5000 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class ModerateMessageDto {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'Contact details shared', maxLength: 255 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(255)
  reason?: string | null;
}

export class CloseConversationDto {
  @ApiProperty({ enum: ConversationClosedScope })
  @IsEnum(ConversationClosedScope)
  scope: ConversationClosedScope;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required with `one_participant`.' })
  @ValidateIf((o: CloseConversationDto) => o.scope === ConversationClosedScope.OneParticipant || o.userId !== undefined)
  @IsUUID('all')
  userId?: string;

  @ApiProperty({ example: 'harassment', maxLength: 60 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  reason: string;

  @ApiPropertyOptional({ description: 'Resolve the open reports on this conversation’s messages. Default `false`.' })
  @IsOptional()
  @IsBoolean()
  resolveReports?: boolean;
}

export class ReadResultDto {
  @ApiProperty({ format: 'uuid' }) conversationId: string;
  @ApiProperty({ example: 0 }) unreadCount: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastReadAt: string | null;
}

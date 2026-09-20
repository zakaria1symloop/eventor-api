import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { trim, trimToNull } from '../../common/dto/transforms.js';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { ConversationKind, ConversationStatus, MessageKind } from '../../common/enums/messaging.enums.js';
import { ReportReason, ReportTargetType } from '../../common/enums/moderation.enums.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

export const CONVERSATION_FILTERS = ['all', 'unread', 'booking'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export class AppConversationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CONVERSATION_FILTERS, default: 'all', description: 'Screen 14’s All / Unread chips; `booking` keeps the chats attached to a booking.' })
  @IsOptional()
  @IsIn(CONVERSATION_FILTERS)
  filter: ConversationFilter = 'all';

  @ApiPropertyOptional({ example: 'studio', description: 'Search the other participant’s name.' })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(2, 80)
  q?: string;
}

export class AppMessagesQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Cursor: return the messages **older** than this one (infinite scroll upwards).' })
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

export class AppStartConversationDto {
  @ApiProperty({ format: 'uuid', description: 'The other person: a client writes to a provider and the other way round. One direct conversation exists per pair, so this is idempotent.' })
  @IsUUID('all')
  userId: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Attach the chat to one of your shared bookings (the context card on screen 15).' })
  @IsOptional()
  @IsUUID('all')
  bookingId?: string;

  @ApiProperty({ example: 'Hello, are you free on 14 November?', maxLength: 4000 })
  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  body: string;
}

export class AppSendMessageDto {
  @ApiPropertyOptional({
    example: 'We can be there from 17:00.',
    maxLength: 4000,
    description: 'Optional only when an image is attached; a message with neither answers 400 `VALIDATION_FAILED`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  body?: string;
}

export const APP_REPORT_TARGETS = [ReportTargetType.Service, ReportTargetType.Pack, ReportTargetType.User, ReportTargetType.Review, ReportTargetType.Message] as const;

export class AppReportDto {
  @ApiProperty({ enum: APP_REPORT_TARGETS, example: ReportTargetType.Service })
  @IsIn(APP_REPORT_TARGETS)
  targetType: (typeof APP_REPORT_TARGETS)[number];

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  targetId: string;

  @ApiProperty({ enum: ReportReason, example: ReportReason.Inappropriate })
  @IsIn(Object.values(ReportReason))
  reason: ReportReason;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 2000)
  note?: string | null;
}

export class AppReportMessageDto {
  @ApiProperty({ enum: ReportReason, example: ReportReason.ContactOutside })
  @IsIn(Object.values(ReportReason))
  reason: ReportReason;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @Length(1, 2000)
  note?: string | null;
}

// ── responses ───────────────────────────────────────────────────

export class AppChatPersonDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'Studio Lumière', description: 'The business name for a provider, the full name for a client. Never an email or a phone.' }) name: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ example: 'provider', enum: ['client', 'provider', 'support'] }) role: string;
  @ApiProperty({ example: false, description: 'The account is blocked, so the chat is read-only for them.' }) blocked: boolean;
}

export class AppChatBookingDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'EVT-000123' }) reference: string;
  @ApiProperty({ enum: BookingStatus }) status: BookingStatus;
  @ApiProperty({ example: '2026-11-14' }) eventDate: string;
  @ApiProperty({ example: 'Wedding photo & video coverage' }) title: string;
  @ApiProperty({ example: '57000.00' }) total: string;
}

export class AppMessageDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) conversationId: string;
  @ApiProperty({ enum: MessageKind }) kind: MessageKind;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Null for a system message.' }) senderId: string | null;
  @ApiProperty({ example: true, description: 'You wrote it.' }) mine: boolean;
  @ApiProperty({
    example: 'Call me on [phone hidden]',
    description: 'Already masked when masking applies — the original text is never sent to a participant.',
  })
  body: string;
  @ApiProperty({ example: false, description: 'Contact details were hidden in this message (status-rules §10).' }) masked: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Signed URL of the image, for an `attachment` message.' }) imageUrl: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Full-size signed URL of the image.' }) imageLargeUrl: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppMessagesPageDto {
  @ApiProperty({ type: [AppMessageDto], description: 'Oldest first, so the list appends at the bottom.' }) data: AppMessageDto[];
  @ApiProperty({ example: { limit: 30, hasMore: true, nextBefore: '…' } })
  meta: { limit: number; hasMore: boolean; nextBefore: string | null };
}

export class AppConversationRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ConversationKind }) kind: ConversationKind;
  @ApiProperty({ enum: ConversationStatus }) status: ConversationStatus;
  @ApiProperty({ type: AppChatPersonDto, nullable: true, description: 'The other participant (Eventor support on a support or dispute chat).' }) other: AppChatPersonDto | null;
  @ApiProperty({ type: String, nullable: true, example: 'See you on the 14th!' }) lastMessage: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastMessageAt: string | null;
  @ApiProperty({ example: 2 }) unreadCount: number;
  @ApiProperty({ type: AppChatBookingDto, nullable: true }) booking: AppChatBookingDto | null;
  @ApiProperty({ example: true, description: 'You may write here (open chat, account not blocked).' }) canWrite: boolean;
}

export class AppConversationDetailDto extends AppConversationRowDto {
  @ApiProperty({ type: [AppChatPersonDto] }) participants: AppChatPersonDto[];
  @ApiProperty({
    example: false,
    description: 'True once the pair share an accepted or completed booking: contact details stop being masked from then on (status-rules §10).',
  })
  contactUnmasked: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The dispute this chat belongs to, when it is a dispute chat.' }) disputeId: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Why an admin closed the chat.' }) closedReason: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class AppReadResultDto {
  @ApiProperty({ format: 'uuid' }) conversationId: string;
  @ApiProperty({ example: 0 }) unreadCount: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastReadAt: string | null;
}

export class AppReportResultDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: true, description: 'False when you had already reported this item and the open report was reused (status-rules §9).' }) created: boolean;
}

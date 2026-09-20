import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { toBoolean } from '../../common/dto/transforms.js';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto.js';

export class AdminNotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '`true`: unread only.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unread?: boolean;
}

export class AdminNotificationDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({
    example: 'review.reported',
    description:
      'verification.submitted, verification.resubmitted, booking.no_reply, dispute.opened, academic_request.new, academic_request.resubmitted, review.reported, message.reported, report.new, export.ready, pack.needs_attention.',
  })
  type: string;
  @ApiProperty({ example: 'Review reported', description: 'In the admin’s language (EN or AR), fixed when the row is written.' }) title: string;
  @ApiProperty({ example: '1★ review by Amina Benali on Studio Lumière contains a phone number.' }) body: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { href: '/reviews/7c4a3e1b-1d2f-4a5b-9c8d-0e1f2a3b4c5d', reviewId: '7c4a3e1b-1d2f-4a5b-9c8d-0e1f2a3b4c5d', reportId: '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d' },
    description: '`href`: dashboard route to open; plus the ids of the objects.',
  })
  data: Record<string, unknown> | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readAt: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}

export class UnreadCountDto {
  @ApiProperty({ example: 4 }) unread: number;
}

export class MarkNotificationsReadDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Notifications to mark as read (ids of other admins are ignored). Required unless `all: true`.' })
  @ValidateIf((o: MarkNotificationsReadDto) => o.all !== true)
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids?: string[];

  @ApiPropertyOptional({ enum: [true], description: 'Mark every notification of the current admin as read.' })
  @IsOptional()
  @IsIn([true])
  all?: true;
}

export class MarkReadResultDto {
  @ApiProperty({ example: 3, description: 'Rows that changed from unread to read.' }) updated: number;
  @ApiProperty({ example: 1 }) unread: number;
}

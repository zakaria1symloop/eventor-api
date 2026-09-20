import { ApiProperty } from '@nestjs/swagger';
import { Language } from '../../common/enums/user.enums.js';
import type { FilesService } from '../../files/files.service.js';
import type { User } from '../../users/entities/user.entity.js';

/** The signed-in admin (`GET /admin/me`, login and refresh responses). */
export class AdminMeDto {
  @ApiProperty({ format: 'uuid', example: '5b0d6c9e-4a51-4c3f-9d0e-2f6b8a7c1e24' })
  id: string;

  @ApiProperty({ example: 'Sara Meziane' })
  fullName: string;

  @ApiProperty({ format: 'email', example: 'admin@eventor.dz' })
  email: string;

  @ApiProperty({ enum: Language, example: Language.En })
  language: Language;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Signed, expiring URL of the avatar, or null.',
  })
  avatarUrl: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-09-01T08:30:00.000Z' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-09-15T10:00:00.000Z' })
  lastActiveAt: string | null;
}

export function toAdminMe(user: User, files: FilesService): AdminMeDto {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    language: user.language,
    avatarUrl: user.avatarFileId ? files.signedUrl(user.avatarFileId) : null,
    createdAt: user.createdAt.toISOString(),
    lastActiveAt: user.lastActiveAt ? user.lastActiveAt.toISOString() : null,
  };
}

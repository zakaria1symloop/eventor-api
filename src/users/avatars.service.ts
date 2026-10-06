import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { FilePurpose } from '../common/enums/file.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { User } from './entities/user.entity.js';

export interface AvatarUpload {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/**
 * Dashboard avatars: an admin's own photo (`/admin/me/avatar`) and an admin
 * replacing or removing a client's or provider's photo (`/admin/users/:id/avatar`).
 * Same rules as the app's `POST /app/me/avatar`: `max_photo_upload_mb`, the type
 * sniffed from the bytes by FilesService, WebP variants built by the photo job,
 * and the previous file deleted.
 */
@Injectable()
export class AvatarsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** `action`: `admin.avatar_updated` (own) or `user.avatar_replaced` (someone else's). */
  async replace(userId: string, file: AvatarUpload | undefined, action: string): Promise<void> {
    if (!file) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: 'file', code: 'REQUIRED', message: 'file is required' }]);
    }
    const maxMb = await this.settings.get('max_photo_upload_mb');
    if (file.size > maxMb * 1024 * 1024) throw new AppException(413, 'FILE_TOO_LARGE', { maxMb });

    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await em.getRepository(User).findOneOrFail({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      const stored = await this.files.store(
        { buffer: file.buffer, originalName: file.originalname, purpose: FilePurpose.Avatar, ownerId: user.id },
        { em, afterCommit },
      );
      const previous = user.avatarFileId;
      await em.getRepository(User).update(user.id, { avatarFileId: stored.id });
      if (previous) await em.query('UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [new Date(), previous]);
      await this.audit.log(
        {
          action,
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Normal,
          changes: { avatarFileId: { from: previous, to: stored.id } },
        },
        em,
      );
    });
  }

  /** Removes the photo (no-op when there is none). `note` is the admin's reason, kept in the activity log. */
  async remove(userId: string, action: string, note: string | null = null): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const user = await em.getRepository(User).findOneOrFail({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      const previous = user.avatarFileId;
      if (!previous) return;
      await em.getRepository(User).update(user.id, { avatarFileId: null });
      await em.query('UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [new Date(), previous]);
      await this.audit.log(
        {
          action,
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Normal,
          changes: { avatarFileId: { from: previous, to: null } },
          note,
        },
        em,
      );
    });
  }
}

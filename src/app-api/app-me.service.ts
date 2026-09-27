import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { fileTypeFromBuffer } from 'file-type';
import { IsNull, MoreThan, type DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { assertPasswordStrong } from '../auth/password.policy.js';
import { PasswordService } from '../auth/password.service.js';
import { Session } from '../auth/entities/session.entity.js';
import { SessionsService } from '../auth/sessions.service.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { SessionAudience } from '../common/enums/auth.enums.js';
import { DocumentStatus, DocumentType, FilePurpose, FileVariantKind } from '../common/enums/file.enums.js';
import { UserRole, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import type { Lang } from '../common/i18n/language.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { DeviceToken } from '../notifications/entities/device-token.entity.js';
import { NotificationPreference } from '../notifications/entities/notification-preference.entity.js';
import { SettingsService } from '../settings/settings.service.js';
import { UserAccountsService } from '../users/user-accounts.service.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { User } from '../users/entities/user.entity.js';
import { algiersToday } from '../users/users.service.js';
import { UserDocument } from '../verification/entities/user-document.entity.js';
import {
  deriveVerificationStatus,
  REQUIRED_DOCUMENT_TYPES,
} from '../verification/verification.policy.js';
import { VERIFICATION_EVENTS, type DocumentUploadedEvent } from '../verification/verification.events.js';
import { avatarUrl, documentLabel, rejectReasonLabel, toCategoryRef, toWilayaRef } from './app-refs.js';
import { pickTextOrNull } from './app.policy.js';
import type {
  AppDeviceTokenDto,
  AppDocumentDto,
  AppDocumentsDto,
  AppMeDto,
  AppNotificationDto,
  AppNotificationPreferencesDto,
  AppNotificationsQueryDto,
  AppSessionRowDto,
  MarkNotificationsReadDto,
  MarkedReadDto,
  RegisterDeviceTokenDto,
  UpdateAppMeDto,
  UpdateNotificationPreferencesDto,
} from './dto/app-me.dto.js';

export const ALLOWED_DOCUMENT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export interface UploadedFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/**
 * Unread conversations of a user: threads holding at least one message from
 * somebody else since they last read it. Mirrors the admin `UNREAD_SQL`.
 */
const UNREAD_CONVERSATIONS_SQL = `SELECT COUNT(*) AS n FROM conversation_participants cp
   JOIN conversations c ON c.id = cp.conversation_id AND c.deleted_at IS NULL
   WHERE cp.user_id = ? AND EXISTS (
     SELECT 1 FROM messages m WHERE m.conversation_id = cp.conversation_id
       AND m.kind <> 'system' AND m.status <> 'deleted'
       AND (m.sender_id IS NULL OR m.sender_id <> cp.user_id)
       AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at))`;

/** `GET/PATCH /app/me` and everything hanging off it: sessions, documents, devices, notifications. */
@Injectable()
export class AppMeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FilesService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly events: DomainEvents,
    private readonly accounts: UserAccountsService,
  ) {}

  // ── profile ─────────────────────────────────────────────────

  async load(userId: string, em: EntityManager = this.dataSource.manager, lock = false): Promise<User> {
    const user = await em.getRepository(User).findOne({
      where: { id: userId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!user) throw AppException.of('USER_NOT_FOUND');
    return user;
  }

  /** The `AppMeDto` of an account, with its provider profile when it has one. */
  async profile(userId: string, lang: Lang, em: EntityManager = this.dataSource.manager): Promise<AppMeDto> {
    const user = await this.load(userId, em);
    const [wilaya] = user.wilayaCode
      ? await em.query('SELECT code, name, name_ar FROM wilayas WHERE code = ?', [user.wilayaCode])
      : [null];

    let provider: AppMeDto['provider'] = null;
    if (user.role === UserRole.Provider) {
      const profile = await em.getRepository(ProviderProfile).findOneBy({ userId: user.id });
      if (profile) {
        const [[category], wilayas] = await Promise.all([
          em.query('SELECT id, slug, name_en, name_ar, icon FROM categories WHERE id = ?', [profile.categoryId]),
          em.query(
            'SELECT w.code, w.name, w.name_ar FROM provider_wilayas pw JOIN wilayas w ON w.code = pw.wilaya_code WHERE pw.provider_profile_id = ? ORDER BY w.code',
            [profile.id],
          ),
        ]);
        provider = {
          businessName: profile.businessName,
          category: toCategoryRef(lang, category),
          bio: pickTextOrNull(lang, profile.bioEn, profile.bioAr),
          bioEn: profile.bioEn,
          bioAr: profile.bioAr,
          languagesSpoken: profile.languagesSpoken,
          yearsActive: profile.yearsActive,
          acceptingBookings: profile.acceptingBookings,
          avgRating: String(profile.avgRating),
          ratingCount: Number(profile.ratingCount),
          completedBookingsCount: Number(profile.completedBookingsCount),
          wilayas: wilayas.map((row: any) => toWilayaRef(lang, row)!),
        };
      }
    }

    const [[unreadNotifications], [unreadConversations]] = await Promise.all([
      em.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL', [user.id]),
      em.query(UNREAD_CONVERSATIONS_SQL, [user.id]),
    ]);

    return {
      id: user.id,
      role: user.role,
      status: user.status,
      verificationStatus: user.verificationStatus,
      fullName: user.fullName,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      phone: user.phone,
      language: user.language,
      wilaya: toWilayaRef(lang, wilaya),
      avatarUrl: avatarUrl(this.files, user.avatarFileId),
      avatarThumbUrl: avatarUrl(this.files, user.avatarFileId, FileVariantKind.Thumb),
      provider,
      unreadNotifications: Number(unreadNotifications.n),
      unreadConversations: Number(unreadConversations.n),
      createdAt: user.createdAt.toISOString(),
    };
  }

  async update(auth: AuthUser, dto: UpdateAppMeDto, lang: Lang): Promise<AppMeDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const user = await this.load(auth.id, em, true);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const patch: Partial<User> = {};

      if (dto.fullName !== undefined && dto.fullName !== user.fullName) {
        changes.fullName = { from: user.fullName, to: dto.fullName };
        patch.fullName = dto.fullName;
      }
      if (dto.phone !== undefined && dto.phone !== user.phone) {
        if (dto.phone !== null) {
          const taken = await em.getRepository(User).exists({ where: { phone: dto.phone }, withDeleted: true });
          if (taken) throw AppException.of('PHONE_TAKEN');
        }
        changes.phone = { from: user.phone, to: dto.phone };
        patch.phone = dto.phone;
      }
      if (dto.language !== undefined && dto.language !== user.language) {
        changes.language = { from: user.language, to: dto.language };
        patch.language = dto.language;
      }
      if (dto.wilayaCode !== undefined && dto.wilayaCode !== user.wilayaCode) {
        if (dto.wilayaCode !== null) {
          const [row] = await em.query('SELECT code FROM wilayas WHERE code = ?', [dto.wilayaCode]);
          if (!row) throw AppException.of('WILAYA_NOT_FOUND', { code: dto.wilayaCode });
        }
        changes.wilayaCode = { from: user.wilayaCode, to: dto.wilayaCode };
        patch.wilayaCode = dto.wilayaCode;
      }
      if (dto.avatarFileId !== undefined && dto.avatarFileId !== user.avatarFileId) {
        if (dto.avatarFileId !== null) {
          const [file] = await em.query("SELECT id FROM files WHERE id = ? AND owner_id = ? AND purpose = 'avatar' AND deleted_at IS NULL", [
            dto.avatarFileId,
            user.id,
          ]);
          if (!file) throw AppException.of('FILE_NOT_FOUND');
        }
        changes.avatarFileId = { from: user.avatarFileId, to: dto.avatarFileId };
        patch.avatarFileId = dto.avatarFileId;
      }

      if (Object.keys(patch).length > 0) {
        await em.getRepository(User).update(user.id, patch);
        await this.audit.log(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'app.profile_updated',
            objectType: 'user',
            objectId: user.id,
            objectLabel: user.fullName,
            level: AuditLevel.Normal,
            changes,
          },
          em,
        );
      }
      return this.profile(user.id, dto.language ?? lang, em);
    });
  }

  async changePassword(auth: AuthUser, currentPassword: string, newPassword: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const user = await this.load(auth.id, em, true);
      if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
        throw AppException.of('CURRENT_PASSWORD_INVALID');
      }
      assertPasswordStrong(newPassword);
      await em.getRepository(User).update(user.id, { passwordHash: await this.passwords.hash(newPassword) });
      const revoked = await this.sessions.revokeAllForUser(user.id, em, { exceptSessionId: auth.sessionId });
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'app.password_changed',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Security,
          changes: { otherSessionsRevoked: revoked },
        },
        em,
      );
    });
  }

  /** Stores an avatar and points the account at it. Returns the refreshed profile. */
  async uploadAvatar(auth: AuthUser, file: UploadedFile, lang: Lang): Promise<AppMeDto> {
    const maxMb = await this.settings.get('max_photo_upload_mb');
    if (file.size > maxMb * 1024 * 1024) throw new AppException(413, 'FILE_TOO_LARGE', { maxMb });

    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await this.load(auth.id, em, true);
      const stored = await this.files.store(
        { buffer: file.buffer, originalName: file.originalname, purpose: FilePurpose.Avatar, ownerId: user.id },
        { em, afterCommit },
      );
      const previous = user.avatarFileId;
      await em.getRepository(User).update(user.id, { avatarFileId: stored.id });
      if (previous) {
        await em.query('UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [new Date(), previous]);
      }
      await this.audit.log(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'app.avatar_updated',
          objectType: 'user',
          objectId: user.id,
          objectLabel: user.fullName,
          level: AuditLevel.Normal,
          changes: { avatarFileId: { from: previous, to: stored.id } },
        },
        em,
      );
      return this.profile(user.id, lang, em);
    });
  }

  /**
   * Soft-deletes my own account, with the same guards as the admin route
   * (`DELETE /admin/users/:id`): upcoming bookings or an open dispute refuse it
   * with 409 ACCOUNT_HAS_ACTIVE_ITEMS. Pending bookings are cancelled, sessions
   * revoked, and personal data is anonymised 30 days later by the nightly job.
   */
  async deleteAccount(auth: AuthUser, password: string): Promise<void> {
    const user = await this.load(auth.id);
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw AppException.of('CURRENT_PASSWORD_INVALID');
    }
    // Delegated to the admin path's service, so the two routes never drift apart.
    await this.accounts.removeSelf(auth, user);
  }

  // ── sessions ────────────────────────────────────────────────

  async listSessions(auth: AuthUser): Promise<AppSessionRowDto[]> {
    const rows = await this.sessions.listActive(auth.id, SessionAudience.App);
    return rows.map((session) => ({
      id: session.id,
      deviceLabel: session.deviceLabel,
      ip: session.ip,
      current: session.id === auth.sessionId,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: iso(session.lastUsedAt),
      expiresAt: session.expiresAt.toISOString(),
    }));
  }

  /** Revokes one of my app sessions (or every other one when `id` is omitted). */
  async revokeSession(auth: AuthUser, id: string | null): Promise<{ revoked: number }> {
    if (id === null) {
      const revoked = await this.sessions.revokeAllForUser(auth.id, this.dataSource.manager, { exceptSessionId: auth.sessionId });
      return { revoked };
    }
    const session = await this.dataSource.getRepository(Session).findOneBy({
      id,
      userId: auth.id,
      audience: SessionAudience.App,
      revokedAt: IsNull(),
      expiresAt: MoreThan(new Date()),
    });
    if (!session) throw AppException.of('SESSION_NOT_FOUND');
    await this.sessions.revoke(session.id);
    return { revoked: 1 };
  }

  // ── provider documents (screens 08a / 08d) ──────────────────

  private async assertProvider(user: User): Promise<void> {
    if (user.role !== UserRole.Provider) throw AppException.of('NOT_A_PROVIDER');
  }

  async documents(auth: AuthUser, lang: Lang): Promise<AppDocumentsDto> {
    const user = await this.load(auth.id);
    await this.assertProvider(user);
    const em = this.dataSource.manager;
    const rows: UserDocument[] = await em.getRepository(UserDocument).find({ where: { userId: user.id }, order: { createdAt: 'DESC' } });
    const maxFileSizeMb = await this.settings.get('max_document_upload_mb');

    const documents: AppDocumentDto[] = REQUIRED_DOCUMENT_TYPES.map((type) => {
      const current = rows.find((row) => row.type === type && row.isCurrent) ?? null;
      const hasOlder = rows.some((row) => row.type === type && !row.isCurrent);
      if (!current) {
        return {
          id: null,
          type,
          label: documentLabel(lang, type),
          status: 'missing' as const,
          fileUrl: null,
          rejectReason: null,
          rejectReasonLabel: null,
          rejectNote: null,
          reviewedAt: null,
          submittedAt: null,
          resubmitted: false,
        };
      }
      return {
        id: current.id,
        type,
        label: documentLabel(lang, type),
        status: current.status,
        fileUrl: this.files.signedUrl(current.fileId),
        rejectReason: current.rejectReason,
        rejectReasonLabel: rejectReasonLabel(lang, current.rejectReason),
        rejectNote: current.rejectNote,
        reviewedAt: iso(current.reviewedAt),
        submittedAt: current.createdAt.toISOString(),
        resubmitted: hasOlder,
      };
    });

    const count = (status: DocumentStatus | 'missing') => documents.filter((d) => d.status === status).length;
    return {
      verificationStatus: user.verificationStatus,
      actionNeeded: documents.some((d) => d.status === DocumentStatus.Rejected || d.status === 'missing'),
      maxFileSizeMb,
      acceptedTypes: [...ALLOWED_DOCUMENT_MIME],
      documents,
      progress: {
        approved: count(DocumentStatus.Approved),
        rejected: count(DocumentStatus.Rejected),
        waiting: count(DocumentStatus.Pending),
        missing: count('missing'),
      },
    };
  }

  /** Resubmit (screens 08a / 08d): a new current version, back to `pending`. */
  async uploadDocument(auth: AuthUser, type: DocumentType, file: UploadedFile, lang: Lang): Promise<AppDocumentsDto> {
    const user = await this.load(auth.id);
    await this.assertProvider(user);
    const maxMb = await this.settings.get('max_document_upload_mb');
    if (file.size > maxMb * 1024 * 1024) throw new AppException(413, 'FILE_TOO_LARGE', { maxMb });
    const mime = (await fileTypeFromBuffer(file.buffer))?.mime;
    if (!mime || !ALLOWED_DOCUMENT_MIME.has(mime)) throw AppException.of('FILE_TYPE_NOT_ALLOWED', { accepted: [...ALLOWED_DOCUMENT_MIME] });

    await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const locked = await this.load(auth.id, em, true);
      const repository = em.getRepository(UserDocument);
      const previous = await repository.find({ where: { userId: locked.id, type, isCurrent: true } });
      if (previous.length > 0) {
        await repository.update(previous.map((d) => d.id), { isCurrent: false });
      }
      const stored = await this.files.store(
        { buffer: file.buffer, originalName: file.originalname, purpose: FilePurpose.Document, ownerId: locked.id },
        { em, afterCommit },
      );
      const document = await repository.save(
        repository.create({ userId: locked.id, type, fileId: stored.id, status: DocumentStatus.Pending, isCurrent: true }),
      );

      // status-rules §2: the account status follows its current documents.
      const current = await repository.find({ where: { userId: locked.id, isCurrent: true }, select: { type: true, status: true } });
      const to = deriveVerificationStatus(current);
      if (to !== locked.verificationStatus) {
        await em.getRepository(User).update(locked.id, { verificationStatus: to });
      }
      await this.audit.log(
        {
          actorId: locked.id,
          actorRole: locked.role,
          action: 'document.uploaded',
          objectType: 'user_document',
          objectId: document.id,
          objectLabel: `${locked.fullName} · ${type}`,
          level: AuditLevel.Normal,
          changes: {
            type,
            replacedDocumentIds: previous.map((d) => d.id),
            ...(to !== locked.verificationStatus ? { verificationStatus: { from: locked.verificationStatus, to } } : {}),
          },
          note: 'Uploaded by the provider from the app',
        },
        em,
      );
      this.events.emitAfterCommit<DocumentUploadedEvent>(afterCommit, VERIFICATION_EVENTS.documentUploaded, {
        documentId: document.id,
        userId: locked.id,
        type,
        uploadedById: locked.id,
      });
    });
    return this.documents(auth, lang);
  }

  // ── device tokens ───────────────────────────────────────────

  /** Idempotent: re-registering the same token moves it to this account. */
  async registerDeviceToken(auth: AuthUser, dto: RegisterDeviceTokenDto): Promise<AppDeviceTokenDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(DeviceToken);
      const existing = await repository.findOne({ where: { token: dto.token }, withDeleted: true });
      if (existing) {
        await repository.update(existing.id, {
          userId: auth.id,
          platform: dto.platform,
          lastSeenAt: new Date(),
          deletedAt: null,
        });
        const row = await repository.findOneByOrFail({ id: existing.id });
        return { id: row.id, token: row.token, platform: row.platform, lastSeenAt: iso(row.lastSeenAt) };
      }
      const row = await repository.save(
        repository.create({ userId: auth.id, token: dto.token, platform: dto.platform, lastSeenAt: new Date() }),
      );
      return { id: row.id, token: row.token, platform: row.platform, lastSeenAt: iso(row.lastSeenAt) };
    });
  }

  async removeDeviceToken(auth: AuthUser, token: string): Promise<void> {
    const repository = this.dataSource.getRepository(DeviceToken);
    const row = await repository.findOneBy({ token, userId: auth.id });
    if (!row) throw AppException.of('DEVICE_TOKEN_NOT_FOUND');
    await repository.softDelete(row.id);
  }

  // ── notification preferences ────────────────────────────────

  async notificationPreferences(auth: AuthUser): Promise<AppNotificationPreferencesDto> {
    const repository = this.dataSource.getRepository(NotificationPreference);
    const row = await repository.findOneBy({ userId: auth.id });
    if (row) return this.toPreferences(row);
    // Defaults, without writing a row until the user changes something.
    return { pushBookings: true, pushMessages: true, pushReviews: true, emailBookings: true, updatedAt: new Date().toISOString() };
  }

  private toPreferences(row: NotificationPreference): AppNotificationPreferencesDto {
    return {
      pushBookings: row.pushBookings,
      pushMessages: row.pushMessages,
      pushReviews: row.pushReviews,
      emailBookings: row.emailBookings,
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  async updateNotificationPreferences(auth: AuthUser, dto: UpdateNotificationPreferencesDto): Promise<AppNotificationPreferencesDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const repository = em.getRepository(NotificationPreference);
      const existing = await repository.findOneBy({ userId: auth.id });
      const next = repository.create({
        userId: auth.id,
        pushBookings: dto.pushBookings ?? existing?.pushBookings ?? true,
        pushMessages: dto.pushMessages ?? existing?.pushMessages ?? true,
        pushReviews: dto.pushReviews ?? existing?.pushReviews ?? true,
        emailBookings: dto.emailBookings ?? existing?.emailBookings ?? true,
      });
      await repository.save(next);
      return this.toPreferences(await repository.findOneByOrFail({ userId: auth.id }));
    });
  }

  // ── notifications (screen 16) ───────────────────────────────

  /** Africa/Algiers sections: today, this week (last 7 days), earlier. */
  private groupOf(createdAt: Date, today: string): AppNotificationDto['group'] {
    const date = new Date(createdAt).toISOString().slice(0, 10);
    if (date === today) return 'today';
    const weekAgo = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    return date >= weekAgo ? 'this_week' : 'earlier';
  }

  async notifications(auth: AuthUser, query: AppNotificationsQueryDto): Promise<Paginated<AppNotificationDto>> {
    const where = ['n.user_id = ?', 'n.deleted_at IS NULL'];
    const params: unknown[] = [auth.id];
    if (query.unread) where.push('n.read_at IS NULL');
    const sql = where.join(' AND ');

    const [rows, [total]] = await Promise.all([
      this.dataSource.query(
        `SELECT n.id, n.type, n.title, n.body, n.data, n.read_at, n.created_at FROM notifications n
         WHERE ${sql} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
        [...params, query.limit, (query.page - 1) * query.limit],
      ),
      this.dataSource.query(`SELECT COUNT(*) AS n FROM notifications n WHERE ${sql}`, params),
    ]);

    const today = algiersToday();
    return paginate(
      rows.map((row: any) => ({
        id: row.id,
        type: row.type as AppNotificationDto['type'],
        title: row.title,
        body: row.body,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? null),
        group: this.groupOf(row.created_at, today),
        read: row.read_at !== null,
        readAt: iso(row.read_at),
        createdAt: new Date(row.created_at).toISOString(),
      })),
      Number(total.n),
      query,
    );
  }

  async unreadCount(auth: AuthUser): Promise<{ unread: number }> {
    const [row] = await this.dataSource.query(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL',
      [auth.id],
    );
    return { unread: Number(row.n) };
  }

  /** Hard-deletes one of the caller's notifications (screen 16 swipe-to-delete). */
  async deleteNotification(auth: AuthUser, id: string): Promise<void> {
    const result = await this.dataSource.query('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, auth.id]);
    if (Number(result?.affectedRows ?? 0) === 0) throw AppException.of('NOTIFICATION_NOT_FOUND');
  }

  async markRead(auth: AuthUser, dto: MarkNotificationsReadDto): Promise<MarkedReadDto> {
    if (!dto.all && (!dto.ids || dto.ids.length === 0)) {
      throw new AppException(400, 'VALIDATION_FAILED', [
        { field: 'ids', code: 'REQUIRED', message: 'Send ids or all: true' },
      ]);
    }
    const now = new Date();
    const result = dto.all
      ? await this.dataSource.query('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL', [now, auth.id])
      : await this.dataSource.query(
          'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL AND id IN (?)',
          [now, auth.id, dto.ids],
        );
    const { unread } = await this.unreadCount(auth);
    return { marked: Number(result?.affectedRows ?? 0), unread };
  }
}

export { VerificationStatus };

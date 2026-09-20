import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { fileTypeFromBuffer } from 'file-type';
import type { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Category } from '../catalog/entities/category.entity.js';
import { Wilaya } from '../catalog/entities/wilaya.entity.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { DocumentStatus, DocumentType, FilePurpose, FileVariantKind } from '../common/enums/file.enums.js';
import { UserRole, VerificationStatus } from '../common/enums/user.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { runInTransaction, type AfterCommit } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderProfile } from '../users/entities/provider-profile.entity.js';
import { User } from '../users/entities/user.entity.js';
import { iso, userSearch } from '../users/users.service.js';
import type { RejectDocumentDto } from './dto/verification.dto.js';
import {
  VERIFICATION_SORT_FIELDS,
  type DocumentDecisionDto,
  type DocumentDto,
  type VerificationDetailDto,
  type VerificationFiltersDto,
  type VerificationNeighboursQueryDto,
  type VerificationRowDto,
  type VerificationsQueryDto,
  type VerificationTabCountsDto,
} from './dto/verification.dto.js';
import { UserDocument } from './entities/user-document.entity.js';
import {
  VERIFICATION_EVENTS,
  type DocumentRejectedEvent,
  type DocumentUploadedEvent,
  type ProviderVerifiedEvent,
  type VerificationStatusChangedEvent,
} from './verification.events.js';
import {
  assertDocumentTransition,
  deriveVerificationStatus,
  documentSummary,
  queueNeighbours,
  REQUIRED_DOCUMENT_TYPES,
  verificationTabOf,
  type DocumentAction,
  type VerificationRowStatus,
} from './verification.policy.js';

const CURRENT_DOCS = 'd.user_id = u.id AND d.is_current = 1 AND d.deleted_at IS NULL';
const PENDING_CURRENT_SQL = `(SELECT COUNT(*) FROM user_documents d WHERE ${CURRENT_DOCS} AND d.status = 'pending')`;
const PENDING_RESUBMITTED_SQL =
  `(SELECT COUNT(*) FROM user_documents d WHERE ${CURRENT_DOCS} AND d.status = 'pending' AND EXISTS ` +
  `(SELECT 1 FROM user_documents o WHERE o.user_id = d.user_id AND o.type = d.type AND o.is_current = 0 AND o.deleted_at IS NULL))`;
const SUBMITTED_AT_SQL = `(SELECT MAX(d.created_at) FROM user_documents d WHERE ${CURRENT_DOCS})`;
/** Same rule as `verificationTabOf`, in SQL. */
const TAB_SQL =
  `(CASE WHEN u.verification_status = 'verified' THEN 'approved' WHEN u.verification_status = 'rejected' THEN 'rejected' ` +
  `WHEN ${PENDING_RESUBMITTED_SQL} > 0 THEN 'resubmitted' WHEN ${PENDING_CURRENT_SQL} > 0 THEN 'waiting' ELSE 'incomplete' END)`;

const SORT_COLUMNS: Record<(typeof VERIFICATION_SORT_FIELDS)[number], string> = {
  submittedAt: 'submitted_at',
  fullName: 'u.full_name',
  createdAt: 'u.created_at',
};

const ALLOWED_DOCUMENT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export interface UploadedDocumentFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** VER-01…VER-04: verification queue, document review, decisions and uploads on a provider's behalf. */
@Injectable()
export class VerificationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
    private readonly settings: SettingsService,
  ) {}

  // ── queue ───────────────────────────────────────────────────

  filtered(filters: VerificationFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<User> {
    const qb = em
      .getRepository(User)
      .createQueryBuilder('u')
      .leftJoin(ProviderProfile, 'pp', 'pp.user_id = u.id AND pp.deleted_at IS NULL')
      .leftJoin(Category, 'c', 'c.id = pp.category_id')
      .leftJoin(Wilaya, 'w', 'w.code = u.wilaya_code')
      .where("u.role = 'provider'");
    if (filters.q) qb.andWhere(userSearch(filters.q));
    if (filters.categoryId) qb.andWhere('pp.category_id = :categoryId', { categoryId: filters.categoryId });
    if (filters.wilaya?.length) qb.andWhere('u.wilaya_code IN (:...wilayas)', { wilayas: filters.wilaya });
    if (filters.documentType) {
      qb.andWhere(`EXISTS (SELECT 1 FROM user_documents d WHERE ${CURRENT_DOCS} AND d.type = :documentType)`, { documentType: filters.documentType });
    }
    if (filters.submittedFrom) qb.andWhere(`${SUBMITTED_AT_SQL} >= :submittedFrom`, { submittedFrom: new Date(`${filters.submittedFrom}T00:00:00.000Z`) });
    if (filters.submittedTo) {
      qb.andWhere(`${SUBMITTED_AT_SQL} < :submittedTo`, { submittedTo: new Date(new Date(`${filters.submittedTo}T00:00:00.000Z`).getTime() + 86_400_000) });
    }
    return qb;
  }

  tabbed(filters: VerificationFiltersDto, em: EntityManager = this.dataSource.manager): SelectQueryBuilder<User> {
    const qb = this.filtered(filters, em);
    const tab = filters.tab ?? 'waiting';
    if (tab !== 'all') qb.andWhere(`${TAB_SQL} = :tab`, { tab });
    return qb;
  }

  private ordered(qb: SelectQueryBuilder<User>, sort: string | undefined): SelectQueryBuilder<User> {
    const [field, direction] = Object.entries(toOrder(sort, VERIFICATION_SORT_FIELDS, ['submittedAt', 'ASC']))[0]! as [
      (typeof VERIFICATION_SORT_FIELDS)[number],
      'ASC' | 'DESC',
    ];
    return qb.addSelect(SUBMITTED_AT_SQL, 'submitted_at').orderBy(SORT_COLUMNS[field], direction).addOrderBy('u.id', 'ASC');
  }

  async fetchRows(filters: VerificationFiltersDto, sort: string | undefined, page: { offset: number; limit: number }): Promise<VerificationRowDto[]> {
    const raw: any[] = await this.ordered(
      this.tabbed(filters)
        .select('u.id', 'id')
        .addSelect('u.full_name', 'full_name')
        .addSelect('u.email', 'email')
        .addSelect('u.phone', 'phone')
        .addSelect('u.avatar_file_id', 'avatar_file_id')
        .addSelect('u.verification_status', 'verification_status')
        .addSelect('u.wilaya_code', 'wilaya_code')
        .addSelect('w.name', 'wilaya_name')
        .addSelect('w.name_ar', 'wilaya_name_ar')
        .addSelect('pp.business_name', 'business_name')
        .addSelect('c.id', 'category_id')
        .addSelect('c.name_en', 'category_name_en')
        .addSelect('c.name_ar', 'category_name_ar')
        .addSelect(TAB_SQL, 'tab'),
      sort,
    )
      .offset(page.offset)
      .limit(page.limit)
      .getRawMany();
    if (raw.length === 0) return [];

    const docs: { user_id: string; type: DocumentType; status: DocumentStatus }[] = await this.dataSource.query(
      'SELECT user_id, type, status FROM user_documents WHERE user_id IN (?) AND is_current = 1 AND deleted_at IS NULL',
      [raw.map((r) => r.id)],
    );
    return raw.map((r) => {
      const summary = documentSummary(docs.filter((d) => d.user_id === r.id));
      return {
        user: {
          id: r.id,
          fullName: r.full_name,
          email: r.email,
          phone: r.phone,
          avatarUrl: r.avatar_file_id ? this.files.signedUrl(r.avatar_file_id, { variant: FileVariantKind.Thumb }) : null,
        },
        businessName: r.business_name,
        category: r.category_id ? { id: r.category_id, nameEn: r.category_name_en, nameAr: r.category_name_ar } : null,
        wilaya: r.wilaya_code !== null && r.wilaya_name ? { code: Number(r.wilaya_code), name: r.wilaya_name, nameAr: r.wilaya_name_ar } : null,
        documents: summary.items,
        progress: summary.progress,
        submittedAt: iso(r.submitted_at),
        status: r.tab as VerificationRowStatus,
        verificationStatus: r.verification_status,
      };
    });
  }

  async list(query: VerificationsQueryDto): Promise<Paginated<VerificationRowDto, VerificationTabCountsDto>> {
    const [rows, total, counts] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.tabbed(query).getCount(),
      this.tabCounts(query),
    ]);
    return paginateWithCounts(rows, total, query, counts);
  }

  /** One grouped query; counters follow the filters but not the tab. */
  async tabCounts(filters: VerificationFiltersDto): Promise<VerificationTabCountsDto> {
    const grouped: { tab: VerificationRowStatus; n: string }[] = await this.filtered({ ...filters, tab: undefined })
      .select(TAB_SQL, 'tab')
      .addSelect('COUNT(*)', 'n')
      .groupBy('tab')
      .getRawMany();
    const get = (tab: VerificationRowStatus) => Number(grouped.find((g) => g.tab === tab)?.n ?? 0);
    const counts = { waiting: get('waiting'), resubmitted: get('resubmitted'), approved: get('approved'), rejected: get('rejected'), incomplete: get('incomplete') };
    return { ...counts, all: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  // ── review ──────────────────────────────────────────────────

  private async loadProvider(userId: string, em: EntityManager, lock = false): Promise<User> {
    const user = await em.getRepository(User).findOne({ where: { id: userId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!user || user.role === UserRole.Admin) throw AppException.of('USER_NOT_FOUND');
    if (user.role !== UserRole.Provider) throw AppException.of('NOT_A_PROVIDER');
    return user;
  }

  private toDocument(doc: UserDocument): DocumentDto {
    return {
      id: doc.id,
      type: doc.type,
      status: doc.status,
      isCurrent: doc.isCurrent,
      viewUrl: this.files.signedUrl(doc.fileId),
      mimeType: doc.file.mimeType,
      sizeBytes: doc.file.sizeBytes,
      fileName: doc.file.originalName,
      uploadedAt: iso(doc.createdAt)!,
      rejectReason: doc.rejectReason,
      rejectNote: doc.rejectNote,
      reviewedBy: doc.reviewedBy ? { id: doc.reviewedBy.id, fullName: doc.reviewedBy.fullName } : null,
      reviewedAt: iso(doc.reviewedAt),
    };
  }

  async detail(userId: string, query: VerificationNeighboursQueryDto): Promise<VerificationDetailDto> {
    const em = this.dataSource.manager;
    const user = await this.loadProvider(userId, em);
    const [profile, wilaya, documents, orderedIds] = await Promise.all([
      em.getRepository(ProviderProfile).findOne({ where: { userId }, relations: { category: true } }),
      user.wilayaCode ? em.getRepository(Wilaya).findOneBy({ code: user.wilayaCode }) : null,
      em.getRepository(UserDocument).find({
        where: { userId },
        relations: { file: true, reviewedBy: true },
        order: { createdAt: 'DESC', id: 'ASC' },
      }),
      this.ordered(this.tabbed(query).select('u.id', 'id'), query.sort).getRawMany<{ id: string }>(),
    ]);
    const current = documents.filter((d) => d.isCurrent);
    const summary = documentSummary(current);
    const pendingCurrent = current.filter((d) => d.status === DocumentStatus.Pending);
    return {
      verificationStatus: user.verificationStatus,
      status: verificationTabOf({
        verificationStatus: user.verificationStatus,
        pendingCurrent: pendingCurrent.length,
        pendingResubmitted: pendingCurrent.filter((d) => documents.some((o) => !o.isCurrent && o.type === d.type)).length,
      }),
      progress: summary.progress,
      documents: REQUIRED_DOCUMENT_TYPES.map((type) => {
        const currentDoc = current.find((d) => d.type === type);
        return {
          type,
          current: currentDoc ? this.toDocument(currentDoc) : null,
          previous: documents.filter((d) => d.type === type && !d.isCurrent).map((d) => this.toDocument(d)),
        };
      }),
      account: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        emailVerifiedAt: iso(user.emailVerifiedAt),
        phone: user.phone,
        avatarUrl: user.avatarFileId ? this.files.signedUrl(user.avatarFileId, { variant: FileVariantKind.Thumb }) : null,
        language: user.language,
        status: user.status,
        businessName: profile?.businessName ?? null,
        category: profile?.category ? { id: profile.category.id, nameEn: profile.category.nameEn, nameAr: profile.category.nameAr } : null,
        wilaya: wilaya ? { code: wilaya.code, name: wilaya.name, nameAr: wilaya.nameAr } : null,
        createdAt: iso(user.createdAt)!,
      },
      neighbours: queueNeighbours(
        orderedIds.map((r) => r.id),
        userId,
      ),
    };
  }

  /** Recomputes `users.verification_status` from the current documents; emits events when it changes. */
  private async recompute(em: EntityManager, afterCommit: AfterCommit, user: User): Promise<{ from: VerificationStatus; to: VerificationStatus; progress: ReturnType<typeof documentSummary>['progress'] }> {
    const current = await em.getRepository(UserDocument).find({ where: { userId: user.id, isCurrent: true }, select: { type: true, status: true } });
    const from = user.verificationStatus;
    const to = deriveVerificationStatus(current);
    if (from !== to) {
      await em.getRepository(User).update(user.id, { verificationStatus: to });
      user.verificationStatus = to;
      this.events.emitAfterCommit<VerificationStatusChangedEvent>(afterCommit, VERIFICATION_EVENTS.statusChanged, { userId: user.id, from, to });
      if (to === VerificationStatus.Verified) {
        this.events.emitAfterCommit<ProviderVerifiedEvent>(afterCommit, VERIFICATION_EVENTS.verified, {
          userId: user.id,
          email: user.email,
          name: user.fullName,
          lang: user.language,
        });
      }
    }
    return { from, to, progress: documentSummary(current).progress };
  }

  async decide(auth: AuthUser, documentId: string, action: DocumentAction, reject?: RejectDocumentDto): Promise<DocumentDecisionDto> {
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const found = await em.getRepository(UserDocument).findOne({ where: { id: documentId }, select: { id: true, userId: true } });
      if (!found) throw AppException.of('DOCUMENT_NOT_FOUND');
      // Lock the provider first so concurrent decisions on the same account recompute in order.
      const user = await this.loadProvider(found.userId, em, true);
      const document = await em.getRepository(UserDocument).findOneOrFail({ where: { id: documentId }, lock: { mode: 'pessimistic_write' } });
      const from = document.status;
      const to = assertDocumentTransition(document, action);

      const reviewed = action === 'undo' ? { reviewedById: null, reviewedAt: null } : { reviewedById: auth.id, reviewedAt: new Date() };
      await em.getRepository(UserDocument).update(document.id, {
        status: to,
        rejectReason: action === 'reject' ? reject!.reasonCode : null,
        rejectNote: action === 'reject' ? reject!.message : null,
        ...reviewed,
      });
      const verification = await this.recompute(em, afterCommit, user);

      await this.audit.log(
        {
          action: action === 'approve' ? 'document.approved' : action === 'reject' ? 'document.rejected' : 'document.decision_undone',
          objectType: 'user_document',
          objectId: document.id,
          objectLabel: `${user.fullName} · ${document.type}`,
          level: action === 'approve' ? AuditLevel.Normal : AuditLevel.Sensitive,
          changes: {
            userId: user.id,
            status: { from, to },
            ...(action === 'reject' ? { reasonCode: reject!.reasonCode } : {}),
            ...(verification.from !== verification.to ? { verificationStatus: { from: verification.from, to: verification.to } } : {}),
          },
          note: action === 'reject' ? reject!.message : null,
        },
        em,
      );
      if (action === 'reject') {
        this.events.emitAfterCommit<DocumentRejectedEvent>(afterCommit, VERIFICATION_EVENTS.documentRejected, {
          documentId: document.id,
          userId: user.id,
          email: user.email,
          name: user.fullName,
          lang: user.language,
          type: document.type,
          reasonCode: reject!.reasonCode,
          message: reject!.message,
        });
      }
      return this.decision(em, document.id, verification);
    });
  }

  private async decision(
    em: EntityManager,
    documentId: string,
    verification: { from: VerificationStatus; to: VerificationStatus; progress: DocumentDecisionDto['progress'] },
  ): Promise<DocumentDecisionDto> {
    const document = await em.getRepository(UserDocument).findOneOrFail({ where: { id: documentId }, relations: { file: true, reviewedBy: true } });
    return {
      document: this.toDocument(document),
      verificationStatus: verification.to,
      previousVerificationStatus: verification.from,
      progress: verification.progress,
    };
  }

  /** Upload on the provider's behalf: a new pending current version; the previous one stops being current. */
  async upload(auth: AuthUser, userId: string, type: DocumentType, file: UploadedDocumentFile): Promise<DocumentDecisionDto> {
    await this.loadProvider(userId, this.dataSource.manager);
    const maxMb = await this.settings.get('max_document_upload_mb');
    if (file.size > maxMb * 1024 * 1024) throw new AppException(413, 'FILE_TOO_LARGE', { maxMb });
    const mime = (await fileTypeFromBuffer(file.buffer))?.mime;
    if (!mime || !ALLOWED_DOCUMENT_MIME.has(mime)) throw AppException.of('FILE_TYPE_NOT_ALLOWED');

    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const user = await this.loadProvider(userId, em, true);
      const previous = await em.getRepository(UserDocument).find({ where: { userId, type, isCurrent: true } });
      if (previous.length > 0) await em.getRepository(UserDocument).update(previous.map((d) => d.id), { isCurrent: false });

      const stored = await this.files.store({ buffer: file.buffer, originalName: file.originalname, purpose: FilePurpose.Document, ownerId: userId }, { em, afterCommit });
      const repository = em.getRepository(UserDocument);
      const document = await repository.save(repository.create({ userId, type, fileId: stored.id, status: DocumentStatus.Pending, isCurrent: true }));
      const verification = await this.recompute(em, afterCommit, user);

      await this.audit.log(
        {
          action: 'document.uploaded',
          objectType: 'user_document',
          objectId: document.id,
          objectLabel: `${user.fullName} · ${type}`,
          level: AuditLevel.Normal,
          changes: {
            userId,
            type,
            replacedDocumentIds: previous.map((d) => d.id),
            ...(verification.from !== verification.to ? { verificationStatus: { from: verification.from, to: verification.to } } : {}),
          },
          note: 'Uploaded by an admin on behalf of the provider',
        },
        em,
      );
      this.events.emitAfterCommit<DocumentUploadedEvent>(afterCommit, VERIFICATION_EVENTS.documentUploaded, {
        documentId: document.id,
        userId,
        type,
        uploadedById: auth.id,
      });
      return this.decision(em, document.id, verification);
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { likeContains } from '../common/dto/transforms.js';
import { FormStatus } from '../common/enums/academic.enums.js';
import { AuditLevel } from '../common/enums/admin.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { paginateWithCounts, type Paginated } from '../common/pagination/paginated.js';
import { toOrder } from '../common/pagination/sort.js';
import { envConfig, type Env } from '../config/env.js';
import { runInTransaction } from '../database/transaction.js';
import { canFormDo, slugify, type FormAction } from './academic.policy.js';
import { FORM_SORT_FIELDS, type CreateFormDto, type FormDetailDto, type FormFiltersDto, type FormRowDto, type FormsQueryDto, type FormTabCountsDto, type FormVersionDto, type SaveDraftDto, type UpdateFormDto } from './dto/forms.dto.js';
import type { FormSchema } from './entities/form-version.entity.js';
import { FormVersion } from './entities/form-version.entity.js';
import { Form } from './entities/form.entity.js';
import { missingTranslations, starterSchema, validateFormSchema } from './form-schema.js';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

const SORT_COLUMNS: Record<(typeof FORM_SORT_FIELDS)[number], string> = {
  updatedAt: 'f.updated_at',
  createdAt: 'f.created_at',
  nameEn: 'f.name_en',
  submissionsCount: 'submissions_count',
};

const SUBMISSIONS_SQL = '(SELECT COUNT(*) FROM academic_requests ar WHERE ar.form_id = f.id AND ar.deleted_at IS NULL)';

export const DEFAULT_CONFIRMATION = {
  en: 'Thank you. Your request was received; we will get back to you by email within 3 working days.',
  ar: 'شكرًا. تم استلام طلبك، وسنعود إليك عبر البريد الإلكتروني خلال 3 أيام عمل.',
};

/** ACR-05, ACR-06: dynamic forms, draft schema and immutable published versions. */
@Injectable()
export class FormsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  publicUrl(slug: string): string {
    return `${this.env.ADMIN_URL.replace(/\/$/, '')}/f/${slug}`;
  }

  // ── list ────────────────────────────────────────────────────

  private where(filters: FormFiltersDto, tab: boolean): { sql: string; params: unknown[] } {
    const clauses = ['f.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (tab && filters.tab && filters.tab !== 'all') {
      clauses.push('f.status = ?');
      params.push(filters.tab);
    }
    if (filters.q) {
      const like = likeContains(filters.q);
      clauses.push('(f.name_en LIKE ? OR f.name_ar LIKE ? OR f.slug LIKE ?)');
      params.push(like, like, like);
    }
    return { sql: clauses.join(' AND '), params };
  }

  async count(filters: FormFiltersDto): Promise<number> {
    const where = this.where(filters, true);
    const [{ n }] = await this.dataSource.query(`SELECT COUNT(*) AS n FROM forms f WHERE ${where.sql}`, where.params);
    return Number(n);
  }

  async fetchRows(filters: FormFiltersDto, sort: string | undefined, page: { offset: number; limit: number }): Promise<FormRowDto[]> {
    const [field, direction] = Object.entries(toOrder(sort, FORM_SORT_FIELDS, ['updatedAt', 'DESC']))[0]! as [(typeof FORM_SORT_FIELDS)[number], 'ASC' | 'DESC'];
    const where = this.where(filters, true);
    const rows: any[] = await this.dataSource.query(
      `SELECT f.*, v.version AS live_version, v.published_at AS live_published_at, v.schema AS live_schema, ${SUBMISSIONS_SQL} AS submissions_count
       FROM forms f LEFT JOIN form_versions v ON v.id = f.live_version_id
       WHERE ${where.sql} ORDER BY ${SORT_COLUMNS[field]} ${direction}, f.id ASC LIMIT ? OFFSET ?`,
      [...where.params, page.limit, page.offset],
    );
    return rows.map((r) => this.toRow(r));
  }

  private toRow(r: any): FormRowDto {
    const draft = r.draft_schema ? json<FormSchema>(r.draft_schema) : null;
    const live = r.live_schema ? json<FormSchema>(r.live_schema) : null;
    return {
      id: r.id,
      slug: r.slug,
      nameEn: r.name_en,
      nameAr: r.name_ar,
      status: r.status,
      isDefault: Number(r.is_default) === 1,
      requiresAuth: Number(r.requires_auth) === 1,
      liveVersion: r.live_version_id ? { id: r.live_version_id, version: Number(r.live_version), publishedAt: iso(r.live_published_at)! } : null,
      submissionsCount: Number(r.submissions_count ?? 0),
      hasDraftChanges: draft !== null && JSON.stringify(draft) !== JSON.stringify(live),
      publicUrl: this.publicUrl(r.slug),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    };
  }

  async list(query: FormsQueryDto): Promise<Paginated<FormRowDto, FormTabCountsDto>> {
    const where = this.where(query, false);
    const [rows, total, [counts]] = await Promise.all([
      this.fetchRows(query, query.sort, { offset: (query.page - 1) * query.limit, limit: query.limit }),
      this.count(query),
      this.dataSource.query(
        `SELECT COUNT(*) AS all_n, COALESCE(SUM(f.status = 'draft'), 0) AS draft, COALESCE(SUM(f.status = 'published'), 0) AS published, COALESCE(SUM(f.status = 'closed'), 0) AS closed
         FROM forms f WHERE ${where.sql}`,
        where.params,
      ),
    ]);
    return paginateWithCounts(rows, total, query, { all: Number(counts.all_n), draft: Number(counts.draft), published: Number(counts.published), closed: Number(counts.closed) });
  }

  // ── detail ──────────────────────────────────────────────────

  async get(id: string, em: EntityManager = this.dataSource.manager): Promise<FormDetailDto> {
    const [r] = await em.query(
      `SELECT f.*, v.version AS live_version, v.published_at AS live_published_at, v.schema AS live_schema, ${SUBMISSIONS_SQL} AS submissions_count, u.full_name AS created_by_name
       FROM forms f LEFT JOIN form_versions v ON v.id = f.live_version_id LEFT JOIN users u ON u.id = f.created_by_id
       WHERE f.id = ? AND f.deleted_at IS NULL`,
      [id],
    );
    if (!r) throw AppException.of('FORM_NOT_FOUND');
    const versions: any[] = await em.query(
      `SELECT v.id, v.version, v.published_at, v.published_by_id, u.full_name, (SELECT COUNT(*) FROM academic_requests ar WHERE ar.form_version_id = v.id AND ar.deleted_at IS NULL) AS submissions_count
       FROM form_versions v LEFT JOIN users u ON u.id = v.published_by_id WHERE v.form_id = ? ORDER BY v.version DESC`,
      [id],
    );
    return {
      ...this.toRow(r),
      descriptionEn: r.description_en,
      descriptionAr: r.description_ar,
      maxSubmissionsPerEmailPerMonth: r.max_submissions_per_email_per_month === null ? null : Number(r.max_submissions_per_email_per_month),
      confirmationEn: r.confirmation_en,
      confirmationAr: r.confirmation_ar,
      draftSchema: r.draft_schema ? json(r.draft_schema) : null,
      versions: versions.map((v) => ({
        id: v.id,
        version: Number(v.version),
        publishedAt: iso(v.published_at)!,
        publishedBy: v.published_by_id ? { id: v.published_by_id, fullName: v.full_name ?? 'Deleted user' } : null,
        submissionsCount: Number(v.submissions_count),
      })),
      createdBy: r.created_by_id ? { id: r.created_by_id, fullName: r.created_by_name ?? 'Deleted user' } : null,
    };
  }

  async version(formId: string, versionId: string): Promise<FormVersionDto> {
    const [v] = await this.dataSource.query(
      `SELECT v.*, u.full_name, (SELECT COUNT(*) FROM academic_requests ar WHERE ar.form_version_id = v.id AND ar.deleted_at IS NULL) AS submissions_count
       FROM form_versions v JOIN forms f ON f.id = v.form_id AND f.deleted_at IS NULL LEFT JOIN users u ON u.id = v.published_by_id WHERE v.id = ? AND v.form_id = ?`,
      [versionId, formId],
    );
    if (!v) {
      await this.load(this.dataSource.manager, formId);
      throw AppException.of('FORM_VERSION_NOT_FOUND');
    }
    return {
      id: v.id,
      formId: v.form_id,
      version: Number(v.version),
      publishedAt: iso(v.published_at)!,
      publishedBy: v.published_by_id ? { id: v.published_by_id, fullName: v.full_name ?? 'Deleted user' } : null,
      submissionsCount: Number(v.submissions_count),
      schema: json(v.schema),
    };
  }

  private async load(em: EntityManager, id: string, lock = false): Promise<Form> {
    const form = await em.getRepository(Form).findOne({ where: { id }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!form) throw AppException.of('FORM_NOT_FOUND');
    return form;
  }

  private assertFresh(form: Form, updatedAt: string | undefined): void {
    if (updatedAt && new Date(updatedAt).getTime() !== new Date(form.updatedAt).getTime()) {
      throw AppException.of('STALE_UPDATE', { updatedAt: form.updatedAt.toISOString() });
    }
  }

  private async slugTaken(em: EntityManager, slug: string, exceptId?: string): Promise<boolean> {
    const rows = await em.query('SELECT id FROM forms WHERE slug = ? AND id <> ?', [slug, exceptId ?? '']);
    return rows.length > 0;
  }

  private async freeSlug(em: EntityManager, base: string): Promise<string> {
    let slug = base.slice(0, 72);
    for (let n = 2; await this.slugTaken(em, slug); n++) slug = `${base.slice(0, 72)}-${n}`;
    return slug;
  }

  // ── writes ──────────────────────────────────────────────────

  async create(auth: AuthUser, dto: CreateFormDto): Promise<FormDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      if (dto.slug && (await this.slugTaken(em, dto.slug))) throw AppException.of('SLUG_TAKEN', { slug: dto.slug });
      const slug = dto.slug ?? (await this.freeSlug(em, slugify(dto.nameEn)));
      const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM forms WHERE is_default = 1 AND deleted_at IS NULL');
      const repository = em.getRepository(Form);
      const form = await repository.save(
        repository.create({
          slug,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          descriptionEn: dto.descriptionEn ?? null,
          descriptionAr: dto.descriptionAr ?? null,
          status: FormStatus.Draft,
          isDefault: Number(n) === 0,
          requiresAuth: false,
          maxSubmissionsPerEmailPerMonth: null,
          confirmationEn: DEFAULT_CONFIRMATION.en,
          confirmationAr: DEFAULT_CONFIRMATION.ar,
          liveVersionId: null,
          draftSchema: starterSchema(),
          createdById: auth.id,
        }),
      );
      await this.audit.log({ action: 'form.created', objectType: 'form', objectId: form.id, objectLabel: form.nameEn, level: AuditLevel.Normal, changes: { slug, nameEn: dto.nameEn, isDefault: form.isDefault } }, em);
      return this.get(form.id, em);
    });
  }

  async update(auth: AuthUser, id: string, dto: UpdateFormDto): Promise<FormDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const form = await this.load(em, id, true);
      this.assertFresh(form, dto.updatedAt);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const update: Partial<Form> = {};
      const keys = ['nameEn', 'nameAr', 'slug', 'descriptionEn', 'descriptionAr', 'requiresAuth', 'maxSubmissionsPerEmailPerMonth', 'confirmationEn', 'confirmationAr', 'isDefault'] as const;
      for (const key of keys) {
        const value = dto[key];
        if (value === undefined || value === form[key]) continue;
        changes[key] = { from: form[key], to: value };
        (update as Record<string, unknown>)[key] = value;
      }
      if (update.slug && (await this.slugTaken(em, update.slug, id))) throw AppException.of('SLUG_TAKEN', { slug: update.slug });
      if (update.isDefault === false) throw AppException.of('FORM_DEFAULT_REQUIRED');
      if (Object.keys(update).length === 0) return this.get(id, em);
      if (update.isDefault) await em.query('UPDATE forms SET is_default = 0 WHERE is_default = 1 AND id <> ?', [id]);
      await em.getRepository(Form).update(id, update as never);
      await this.audit.log({ action: 'form.updated', objectType: 'form', objectId: id, objectLabel: update.nameEn ?? form.nameEn, level: AuditLevel.Normal, changes }, em);
      return this.get(id, em);
    });
  }

  async saveDraft(auth: AuthUser, id: string, dto: SaveDraftDto): Promise<FormDetailDto> {
    const issues = validateFormSchema(dto.schema);
    if (issues.length > 0) throw AppException.of('FORM_SCHEMA_INVALID', issues);
    return runInTransaction(this.dataSource, async (em) => {
      const form = await this.load(em, id, true);
      this.assertFresh(form, dto.updatedAt);
      const schema = dto.schema as unknown as FormSchema;
      await em.getRepository(Form).update(id, { draftSchema: schema as never });
      await this.audit.log({ action: 'form.draft_saved', objectType: 'form', objectId: id, objectLabel: form.nameEn, level: AuditLevel.Info, changes: { fields: schema.fields.length } }, em);
      return this.get(id, em);
    });
  }

  private assertMove(form: Form, action: FormAction): void {
    if (!canFormDo(form.status, action)) throw AppException.of('FORM_INVALID_TRANSITION', { status: form.status, action });
  }

  async publish(auth: AuthUser, id: string): Promise<FormDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const form = await this.load(em, id, true);
      this.assertMove(form, 'publish');
      const schema = form.draftSchema;
      const issues = validateFormSchema(schema, { publish: true });
      if (!schema || issues.length > 0) throw AppException.of('FORM_SCHEMA_INVALID', schema ? issues : [{ path: 'schema', code: 'SCHEMA_NOT_OBJECT' }]);
      const missing = missingTranslations(schema);
      if (missing.length > 0) throw AppException.of('FORM_TRANSLATION_MISSING', missing);
      const [{ n }] = await em.query('SELECT COALESCE(MAX(version), 0) AS n FROM form_versions WHERE form_id = ?', [id]);
      const repository = em.getRepository(FormVersion);
      const version = await repository.save(repository.create({ formId: id, version: Number(n) + 1, schema, publishedById: auth.id, publishedAt: new Date() }));
      await em.getRepository(Form).update(id, { liveVersionId: version.id, status: FormStatus.Published });
      await this.audit.log(
        { action: 'form.published', objectType: 'form', objectId: id, objectLabel: form.nameEn, level: AuditLevel.Normal, changes: { status: { from: form.status, to: FormStatus.Published }, version: version.version, versionId: version.id } },
        em,
      );
      return this.get(id, em);
    });
  }

  async close(auth: AuthUser, id: string, action: 'close' | 'reopen'): Promise<FormDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const form = await this.load(em, id, true);
      this.assertMove(form, action);
      if (action === 'reopen' && !form.liveVersionId) throw AppException.of('FORM_INVALID_TRANSITION', { status: form.status, action });
      const to = action === 'close' ? FormStatus.Closed : FormStatus.Published;
      await em.getRepository(Form).update(id, { status: to });
      await this.audit.log({ action: action === 'close' ? 'form.closed' : 'form.reopened', objectType: 'form', objectId: id, objectLabel: form.nameEn, level: AuditLevel.Normal, changes: { status: { from: form.status, to } } }, em);
      return this.get(id, em);
    });
  }

  async duplicate(auth: AuthUser, id: string): Promise<FormDetailDto> {
    return runInTransaction(this.dataSource, async (em) => {
      const form = await this.load(em, id);
      let schema = form.draftSchema;
      if (!schema && form.liveVersionId) schema = (await em.getRepository(FormVersion).findOneByOrFail({ id: form.liveVersionId })).schema;
      const slug = await this.freeSlug(em, `${form.slug.slice(0, 70)}-copy`);
      const repository = em.getRepository(Form);
      const copy = await repository.save(
        repository.create({
          slug,
          nameEn: `${form.nameEn} (copy)`.slice(0, 160),
          nameAr: `${form.nameAr} (نسخة)`.slice(0, 160),
          descriptionEn: form.descriptionEn,
          descriptionAr: form.descriptionAr,
          status: FormStatus.Draft,
          isDefault: false,
          requiresAuth: form.requiresAuth,
          maxSubmissionsPerEmailPerMonth: form.maxSubmissionsPerEmailPerMonth,
          confirmationEn: form.confirmationEn,
          confirmationAr: form.confirmationAr,
          liveVersionId: null,
          draftSchema: schema ?? starterSchema(),
          createdById: auth.id,
        }),
      );
      await this.audit.log({ action: 'form.duplicated', objectType: 'form', objectId: copy.id, objectLabel: copy.nameEn, level: AuditLevel.Normal, changes: { sourceFormId: id, slug } }, em);
      return this.get(copy.id, em);
    });
  }

  async remove(auth: AuthUser, id: string): Promise<void> {
    await runInTransaction(this.dataSource, async (em) => {
      const form = await this.load(em, id, true);
      const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM academic_requests WHERE form_id = ?', [id]);
      if (Number(n) > 0) throw AppException.of('FORM_HAS_SUBMISSIONS', { submissionsCount: Number(n) });
      if (form.isDefault) throw AppException.of('FORM_DEFAULT_REQUIRED');
      const freed = `${form.slug.slice(0, 60)}-deleted-${Date.now().toString(36)}`.slice(0, 80);
      await em.query('UPDATE forms SET slug = ?, deleted_at = ? WHERE id = ?', [freed, new Date(), id]);
      await this.audit.log({ action: 'form.deleted', objectType: 'form', objectId: id, objectLabel: form.nameEn, level: AuditLevel.Sensitive, changes: { slug: form.slug, status: form.status } }, em);
    });
  }
}

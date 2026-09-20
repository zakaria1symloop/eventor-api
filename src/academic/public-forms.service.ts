import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { fileTypeFromBuffer } from 'file-type';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { VerificationCode } from '../auth/entities/verification-code.entity.js';
import { parseKeyedToken, tokenMatchesHash } from '../auth/refresh-token.js';
import { algiersToday } from '../bookings/bookings.service.js';
import { AcademicRequestStatus, FormStatus } from '../common/enums/academic.enums.js';
import { AuditLevel, AuditSource } from '../common/enums/admin.enums.js';
import { VerificationCodePurpose } from '../common/enums/auth.enums.js';
import { EventType } from '../common/enums/catalog.enums.js';
import { FilePurpose } from '../common/enums/file.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { DomainEvents } from '../common/events/domain-events.js';
import type { Lang } from '../common/i18n/language.js';
import { envConfig, type Env } from '../config/env.js';
import { runInTransaction } from '../database/transaction.js';
import { FilesService } from '../files/files.service.js';
import { SequencesService } from '../sequences/sequences.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ACADEMIC_EVENTS, type FormCodeSentEvent, type RequestResubmittedEvent, type RequestSubmittedEvent } from './academic.events.js';
import { canDo, FORM_CODE_MAX_ATTEMPTS, FORM_CODE_RESEND_SECONDS, FORM_CODE_TTL_MINUTES, monthStartUtc, UPLOAD_TOKEN_TTL_SECONDS } from './academic.policy.js';
import type { EditableRequestDto, EditAnswersDto, EmailCodeResultDto, PublicFormDto, SubmissionResultDto, SubmitFormDto, UploadRefDto, UploadResultDto } from './dto/public-forms.dto.js';
import { AcademicRequestAttachment } from './entities/academic-request-attachment.entity.js';
import { AcademicRequestNeed } from './entities/academic-request-need.entity.js';
import { AcademicRequest } from './entities/academic-request.entity.js';
import type { FormSchema } from './entities/form-version.entity.js';
import { changedKeys, mappedColumns, validateAnswers, type UploadedAnswerFile } from './form-answers.js';
import { FILE_MIME } from './form-schema.js';

const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
const EVENT_TYPES = Object.values(EventType) as string[];
const UPLOAD_MIME = new Set(Object.values(FILE_MIME));

export interface RequestedChangesState {
  fields: string[];
  message: string;
  requestedAt: string;
  requestedById: string | null;
  tokenHash: string | null;
  tokenExpiresAt: string | null;
  previousAnswers: Record<string, unknown>;
  resubmittedAt: string | null;
  changedFields: string[];
}

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** ACR-07: the public web form (`/f/:slug`), email codes, uploads, submissions and the changes-requested edit link. */
@Injectable()
export class PublicFormsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(envConfig.KEY) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly files: FilesService,
    private readonly sequences: SequencesService,
    private readonly settings: SettingsService,
  ) {}

  // ── form ────────────────────────────────────────────────────

  private async liveForm(em: EntityManager, slug: string): Promise<any> {
    const [form] = await em.query(
      `SELECT f.*, v.version, v.schema, v.id AS version_id FROM forms f LEFT JOIN form_versions v ON v.id = f.live_version_id
       WHERE f.slug = ? AND f.deleted_at IS NULL`,
      [slug],
    );
    if (!form || !form.version_id || form.status === FormStatus.Draft) throw AppException.of('FORM_NOT_FOUND');
    if (form.status === FormStatus.Closed) throw AppException.of('FORM_CLOSED');
    return form;
  }

  async getForm(slug: string): Promise<PublicFormDto> {
    const form = await this.liveForm(this.dataSource.manager, slug);
    return {
      slug: form.slug,
      nameEn: form.name_en,
      nameAr: form.name_ar,
      descriptionEn: form.description_en,
      descriptionAr: form.description_ar,
      version: Number(form.version),
      schema: json(form.schema),
      requiresAuth: Number(form.requires_auth) === 1,
      maxSubmissionsPerEmailPerMonth: form.max_submissions_per_email_per_month === null ? null : Number(form.max_submissions_per_email_per_month),
      confirmationEn: form.confirmation_en,
      confirmationAr: form.confirmation_ar,
      uploadMaxMb: Number(await this.settings.get('max_document_upload_mb')),
    };
  }

  // ── email code ──────────────────────────────────────────────

  private codeHash(email: string, code: string): string {
    return createHmac('sha256', this.env.FILES_SIGNING_SECRET).update(`form_submission:${email}:${code}`).digest('hex');
  }

  async sendCode(slug: string, email: string, lang: Lang, now = new Date()): Promise<EmailCodeResultDto> {
    await this.liveForm(this.dataSource.manager, slug);
    return runInTransaction(this.dataSource, async (em, afterCommit) => {
      const [last] = await em.query('SELECT created_at FROM verification_codes WHERE destination = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [
        email,
        VerificationCodePurpose.FormSubmission,
      ]);
      if (last) {
        const wait = Math.ceil((new Date(last.created_at).getTime() + FORM_CODE_RESEND_SECONDS * 1000 - now.getTime()) / 1000);
        if (wait > 0) throw AppException.of('CODE_RESEND_TOO_SOON', { retryAfterSeconds: wait });
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(now.getTime() + FORM_CODE_TTL_MINUTES * 60_000);
      // Older codes stop working once a new one is issued.
      await em.query('UPDATE verification_codes SET consumed_at = ? WHERE destination = ? AND purpose = ? AND consumed_at IS NULL', [now, email, VerificationCodePurpose.FormSubmission]);
      const repository = em.getRepository(VerificationCode);
      await repository.save(repository.create({ userId: null, purpose: VerificationCodePurpose.FormSubmission, destination: email, codeHash: this.codeHash(email, code), attempts: 0, expiresAt, consumedAt: null, createdAt: now }));
      this.events.emitAfterCommit<FormCodeSentEvent>(afterCommit, ACADEMIC_EVENTS.formCodeSent, { email, code, minutes: FORM_CODE_TTL_MINUTES, lang });
      return { email, expiresAt: expiresAt.toISOString(), resendAfterSeconds: FORM_CODE_RESEND_SECONDS };
    });
  }

  /** Checks the latest code; a wrong code counts an attempt (committed even though the request fails). Returns the code id to consume. */
  private async checkCode(email: string, code: string, now: Date): Promise<string> {
    const [row] = await this.dataSource.query(
      'SELECT id, code_hash, attempts, expires_at FROM verification_codes WHERE destination = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [email, VerificationCodePurpose.FormSubmission],
    );
    if (!row) throw AppException.of('CODE_INVALID');
    if (new Date(row.expires_at).getTime() <= now.getTime() || Number(row.attempts) >= FORM_CODE_MAX_ATTEMPTS) throw AppException.of('CODE_EXPIRED');
    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(this.codeHash(email, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await this.dataSource.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      throw AppException.of('CODE_INVALID');
    }
    return row.id;
  }

  // ── uploads ─────────────────────────────────────────────────

  private uploadSignature(fileId: string, formId: string, exp: number): string {
    return createHmac('sha256', this.env.FILES_SIGNING_SECRET).update(`form-upload:${fileId}:${formId}:${exp}`).digest('base64url');
  }

  async upload(slug: string, file: UploadedFile, now = new Date()): Promise<UploadResultDto> {
    const form = await this.liveForm(this.dataSource.manager, slug);
    const maxMb = Number(await this.settings.get('max_document_upload_mb'));
    if (file.buffer.length > maxMb * 1024 * 1024) throw new AppException(413, 'FILE_TOO_LARGE', { maxMb });
    const sniffed = (await fileTypeFromBuffer(file.buffer))?.mime;
    if (!sniffed || !UPLOAD_MIME.has(sniffed)) throw AppException.of('FILE_TYPE_NOT_ALLOWED', { allowed: ['pdf', 'jpg', 'png'] });
    const stored = await this.files.store({ buffer: file.buffer, originalName: file.originalname, purpose: FilePurpose.Attachment, ownerId: null });
    const exp = Math.floor(now.getTime() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
    return {
      uploadToken: `${stored.id}.${exp}.${this.uploadSignature(stored.id, form.id, exp)}`,
      fileName: stored.originalName,
      mimeType: stored.mimeType,
      sizeBytes: Number(stored.sizeBytes),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Upload tokens → files per field key (422 UPLOAD_TOKEN_INVALID when forged, expired, for another form, or already attached). */
  private async resolveUploads(em: EntityManager, formId: string, uploads: UploadRefDto[] | undefined, now: Date): Promise<Record<string, UploadedAnswerFile[]>> {
    const byKey: Record<string, UploadedAnswerFile[]> = {};
    for (const upload of uploads ?? []) {
      const match = /^([0-9a-f-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(upload.uploadToken);
      if (!match) throw AppException.of('UPLOAD_TOKEN_INVALID', { fieldKey: upload.fieldKey });
      const [, fileId, expRaw, sig] = match as unknown as [string, string, string, string];
      const exp = Number(expRaw);
      const expected = Buffer.from(this.uploadSignature(fileId, formId, exp));
      const given = Buffer.from(sig);
      if (expected.length !== given.length || !timingSafeEqual(expected, given) || exp * 1000 <= now.getTime()) throw AppException.of('UPLOAD_TOKEN_INVALID', { fieldKey: upload.fieldKey });
      const [file] = await em.query(
        `SELECT f.id, f.mime_type, f.size_bytes, f.original_name FROM files f
         WHERE f.id = ? AND f.purpose = 'attachment' AND f.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM academic_request_attachments a WHERE a.file_id = f.id)`,
        [fileId],
      );
      if (!file) throw AppException.of('UPLOAD_TOKEN_INVALID', { fieldKey: upload.fieldKey });
      if (Object.values(byKey).some((list) => list.some((f) => f.fileId === fileId))) throw AppException.of('UPLOAD_TOKEN_INVALID', { fieldKey: upload.fieldKey });
      (byKey[upload.fieldKey] ??= []).push({ fileId, mimeType: file.mime_type, sizeBytes: Number(file.size_bytes), originalName: file.original_name });
    }
    return byKey;
  }

  private async answerContext(em: EntityManager, files: Record<string, UploadedAnswerFile[]>, now: Date) {
    const [wilayas, categories] = await Promise.all([
      em.query('SELECT code FROM wilayas'),
      em.query('SELECT id FROM categories WHERE deleted_at IS NULL AND is_visible = 1'),
    ]);
    return {
      today: algiersToday(now),
      wilayaCodes: new Set<number>(wilayas.map((w: { code: number }) => Number(w.code))),
      categoryIds: new Set<string>(categories.map((c: { id: string }) => c.id)),
      files,
      maxUploadMb: Number(await this.settings.get('max_document_upload_mb')),
    };
  }

  // ── submission ──────────────────────────────────────────────

  async submit(slug: string, dto: SubmitFormDto, lang: Lang, now = new Date()): Promise<SubmissionResultDto> {
    const em = this.dataSource.manager;
    const form = await this.liveForm(em, slug);
    const schema = json<FormSchema>(form.schema);
    const files = await this.resolveUploads(em, form.id, dto.uploads, now);
    const result = validateAnswers(schema, dto.answers, await this.answerContext(em, files, now));
    if (result.errors.length > 0) throw AppException.of('FORM_ANSWERS_INVALID', result.errors);

    const [client] = await em.query("SELECT id, language FROM users WHERE email = ? AND role = 'client' AND status = 'active' AND deleted_at IS NULL", [dto.email]);
    if (Number(form.requires_auth) === 1 && !client) throw AppException.of('FORM_REQUIRES_ACCOUNT');
    const codeId = await this.checkCode(dto.email, dto.code, now);
    const limit = form.max_submissions_per_email_per_month === null ? null : Number(form.max_submissions_per_email_per_month);
    if (limit !== null) {
      const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM academic_requests WHERE form_id = ? AND requester_email = ? AND submitted_at >= ? AND deleted_at IS NULL', [
        form.id,
        dto.email,
        monthStartUtc(now),
      ]);
      if (Number(n) >= limit) throw AppException.of('FORM_SUBMISSION_LIMIT', { limit });
    }

    return runInTransaction(this.dataSource, async (tx, afterCommit) => {
      const consumed = await tx.query('UPDATE verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [now, codeId]);
      if (Number(consumed?.affectedRows ?? 0) !== 1) throw AppException.of('CODE_INVALID');
      const mapped = mappedColumns(schema, result.answers, EVENT_TYPES);
      const repository = tx.getRepository(AcademicRequest);
      const request = await repository.save(
        repository.create({
          reference: await this.sequences.next('academic_request', tx),
          formId: form.id,
          formVersionId: form.version_id,
          answers: result.answers,
          requesterId: client?.id ?? null,
          requesterName: (mapped.requesterName ?? dto.email.split('@')[0]!).slice(0, 120),
          requesterEmail: dto.email,
          requesterPhone: (mapped.requesterPhone ?? '').slice(0, 20),
          institutionName: mapped.institutionName?.slice(0, 190) ?? null,
          title: (mapped.title ?? form.name_en).slice(0, 190),
          eventType: mapped.eventType as EventType | null,
          eventDate: mapped.eventDate,
          wilayaCode: mapped.wilayaCode,
          attendees: mapped.attendees,
          budgetMin: mapped.budgetMin,
          budgetMax: mapped.budgetMax,
          status: AcademicRequestStatus.Pending,
          requestedChanges: null,
          submittedAt: now,
        }),
      );
      await this.writeNeeds(tx, request.id, mapped.needs);
      await this.writeAttachments(tx, request.id, files, client?.id ?? null);
      const requesterLang: Lang = lang;
      await this.audit.log(
        {
          actorId: client?.id ?? null,
          actorRole: null,
          source: AuditSource.Web,
          action: 'academic_request.submitted',
          objectType: 'academic_request',
          objectId: request.id,
          objectLabel: `${request.reference} ${request.title}`,
          level: AuditLevel.Normal,
          changes: { formId: form.id, version: Number(form.version), email: dto.email, lang: requesterLang, linkedAccount: !!client },
        },
        tx,
      );
      this.events.emitAfterCommit<RequestSubmittedEvent>(afterCommit, ACADEMIC_EVENTS.submitted, {
        requestId: request.id,
        reference: request.reference,
        title: request.title,
        formSlug: form.slug,
        requester: { name: request.requesterName, email: request.requesterEmail, userId: request.requesterId },
        lang: requesterLang,
        confirmation: requesterLang === 'ar' ? form.confirmation_ar : form.confirmation_en,
        submittedAt: now.toISOString(),
      });
      return { reference: request.reference, status: request.status, submittedAt: now.toISOString(), confirmationEn: form.confirmation_en, confirmationAr: form.confirmation_ar };
    });
  }

  async writeNeeds(em: EntityManager, requestId: string, categoryIds: string[]): Promise<void> {
    await em.query('DELETE FROM academic_request_needs WHERE request_id = ?', [requestId]);
    const repository = em.getRepository(AcademicRequestNeed);
    for (const categoryId of categoryIds) await repository.save(repository.create({ requestId, categoryId, note: null }));
  }

  private async writeAttachments(em: EntityManager, requestId: string, files: Record<string, UploadedAnswerFile[]>, ownerId: string | null): Promise<void> {
    const repository = em.getRepository(AcademicRequestAttachment);
    for (const [fieldKey, list] of Object.entries(files)) {
      await em.query('DELETE FROM academic_request_attachments WHERE request_id = ? AND field_key = ?', [requestId, fieldKey]);
      for (const file of list) {
        await repository.save(repository.create({ requestId, fileId: file.fileId, fieldKey }));
        if (ownerId) await em.query('UPDATE files SET owner_id = ? WHERE id = ?', [ownerId, file.fileId]);
      }
    }
  }

  // ── edit link (changes requested) ───────────────────────────

  private async loadByToken(em: EntityManager, slug: string, token: string, lock: boolean, now: Date): Promise<{ request: any; state: RequestedChangesState }> {
    const parsed = parseKeyedToken(token);
    if (!parsed) throw AppException.of('EDIT_LINK_INVALID');
    const [request] = await em.query(
      `SELECT ar.*, f.slug, f.name_en AS form_name_en, f.name_ar AS form_name_ar, v.version, v.schema FROM academic_requests ar
       JOIN forms f ON f.id = ar.form_id JOIN form_versions v ON v.id = ar.form_version_id
       WHERE ar.id = ? AND ar.deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [parsed.id],
    );
    const state = request?.requested_changes ? json<RequestedChangesState>(request.requested_changes) : null;
    if (
      !request ||
      request.slug !== slug ||
      !state?.tokenHash ||
      !state.tokenExpiresAt ||
      new Date(state.tokenExpiresAt).getTime() <= now.getTime() ||
      !tokenMatchesHash(parsed.token, state.tokenHash) ||
      !canDo(request.status, 'resubmit')
    ) {
      throw AppException.of('EDIT_LINK_INVALID');
    }
    return { request, state };
  }

  async getEditable(slug: string, token: string, now = new Date()): Promise<EditableRequestDto> {
    const { request, state } = await this.loadByToken(this.dataSource.manager, slug, token, false, now);
    return {
      reference: request.reference,
      status: request.status,
      requestedChanges: { fields: state.fields, message: state.message },
      formNameEn: request.form_name_en,
      formNameAr: request.form_name_ar,
      version: Number(request.version),
      schema: json(request.schema),
      answers: json(request.answers),
      email: request.requester_email,
      linkExpiresAt: state.tokenExpiresAt!,
    };
  }

  async editAnswers(slug: string, token: string, dto: EditAnswersDto, now = new Date()): Promise<EditableRequestDto & { changedFields: string[] }> {
    const changed = await runInTransaction(this.dataSource, async (em, afterCommit) => {
      const { request, state } = await this.loadByToken(em, slug, token, true, now);
      const schema = json<FormSchema>(request.schema);
      const uploaded = await this.resolveUploads(em, request.form_id, dto.uploads, now);
      const existing: any[] = await em.query(
        'SELECT a.field_key, f.id, f.mime_type, f.size_bytes, f.original_name FROM academic_request_attachments a JOIN files f ON f.id = a.file_id WHERE a.request_id = ? ORDER BY a.created_at',
        [request.id],
      );
      const files: Record<string, UploadedAnswerFile[]> = {};
      for (const row of existing) (files[row.field_key] ??= []).push({ fileId: row.id, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), originalName: row.original_name });
      Object.assign(files, uploaded);
      // Attachments of fields that no longer exist or are hidden are ignored by the validator; drop their keys from the context.
      for (const key of Object.keys(files)) if (!schema.fields.some((f) => f.key === key && f.type === 'file')) delete files[key];
      const result = validateAnswers(schema, dto.answers, await this.answerContext(em, files, now));
      if (result.errors.length > 0) throw AppException.of('FORM_ANSWERS_INVALID', result.errors);

      const previous = json<Record<string, unknown>>(request.answers);
      const changedFields = changedKeys(previous, result.answers);
      const mapped = mappedColumns(schema, result.answers, EVENT_TYPES);
      await em.getRepository(AcademicRequest).update(request.id, {
        answers: result.answers as never,
        requesterName: (mapped.requesterName ?? request.requester_name).slice(0, 120),
        requesterPhone: (mapped.requesterPhone ?? request.requester_phone).slice(0, 20),
        institutionName: mapped.institutionName?.slice(0, 190) ?? null,
        title: (mapped.title ?? request.title).slice(0, 190),
        eventType: mapped.eventType as EventType | null,
        eventDate: mapped.eventDate,
        wilayaCode: mapped.wilayaCode,
        attendees: mapped.attendees,
        budgetMin: mapped.budgetMin,
        budgetMax: mapped.budgetMax,
        status: AcademicRequestStatus.Pending,
        requestedChanges: { ...state, tokenHash: null, tokenExpiresAt: null, resubmittedAt: now.toISOString(), changedFields } as never,
      });
      await this.writeNeeds(em, request.id, mapped.needs);
      await this.writeAttachments(em, request.id, uploaded, request.requester_id);
      await this.audit.log(
        {
          actorId: request.requester_id,
          actorRole: null,
          source: AuditSource.Web,
          action: 'academic_request.resubmitted',
          objectType: 'academic_request',
          objectId: request.id,
          objectLabel: `${request.reference} ${request.title}`,
          level: AuditLevel.Normal,
          changes: { status: { from: request.status, to: AcademicRequestStatus.Pending }, changedFields },
        },
        em,
      );
      this.events.emitAfterCommit<RequestResubmittedEvent>(afterCommit, ACADEMIC_EVENTS.resubmitted, {
        requestId: request.id,
        reference: request.reference,
        title: mapped.title ?? request.title,
        formSlug: request.slug,
        requester: { name: request.requester_name, email: request.requester_email, userId: request.requester_id },
        lang: 'en',
        changedFields,
      });
      return {
        reference: request.reference as string,
        formNameEn: request.form_name_en as string,
        formNameAr: request.form_name_ar as string,
        version: Number(request.version),
        schema: json<Record<string, unknown>>(request.schema),
        answers: result.answers,
        email: request.requester_email as string,
        state,
        changedFields,
      };
    });
    return {
      reference: changed.reference,
      status: AcademicRequestStatus.Pending,
      requestedChanges: { fields: changed.state.fields, message: changed.state.message },
      formNameEn: changed.formNameEn,
      formNameAr: changed.formNameAr,
      version: changed.version,
      schema: changed.schema,
      answers: changed.answers,
      email: changed.email,
      linkExpiresAt: now.toISOString(),
      changedFields: changed.changedFields,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { displayValue } from '../academic/academic-requests.service.js';
import type { FormField, FormSchema } from '../academic/entities/form-version.entity.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { AcademicRequestStatus } from '../common/enums/academic.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import { paginate, type Paginated } from '../common/pagination/paginated.js';
import type { AppAcademicRequestDetailDto, AppAcademicRequestRowDto } from './dto/app-academic.dto.js';

const iso = (value: Date | string): string => new Date(value).toISOString();
const dateOnly = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : String(value).slice(0, 10);

/**
 * "My event requests": the academic requests linked to this account by
 * `requester_id`. Read-only — a requester edits answers through the emailed
 * token link, and the handling itself is the admin's (status-rules §7).
 */
@Injectable()
export class AppAcademicService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(auth: AuthUser, query: { page: number; limit: number }): Promise<Paginated<AppAcademicRequestRowDto>> {
    const em = this.dataSource.manager;
    const where = 'ar.requester_id = ? AND ar.deleted_at IS NULL';
    const [[count], rows] = await Promise.all([
      em.query(`SELECT COUNT(*) AS n FROM academic_requests ar WHERE ${where}`, [auth.id]),
      em.query(
        `SELECT ar.id, ar.reference, ar.title, ar.status, ar.event_date, ar.submitted_at
           FROM academic_requests ar WHERE ${where}
          ORDER BY ar.submitted_at DESC, ar.id DESC LIMIT ? OFFSET ?`,
        [auth.id, query.limit, (query.page - 1) * query.limit],
      ),
    ]);
    return paginate((rows as any[]).map((r) => this.toRow(r)), Number(count.n), query);
  }

  private toRow(r: any): AppAcademicRequestRowDto {
    return {
      id: r.id,
      reference: r.reference,
      title: r.title,
      status: r.status as AcademicRequestStatus,
      eventDate: dateOnly(r.event_date),
      submittedAt: iso(r.submitted_at),
    };
  }

  /** One of my requests, with the answers rendered by the version's own schema. */
  async detail(auth: AuthUser, id: string): Promise<AppAcademicRequestDetailDto> {
    const em = this.dataSource.manager;
    const [r] = await em.query(
      `SELECT ar.id, ar.reference, ar.title, ar.status, ar.event_date, ar.submitted_at, ar.answers, fv.schema
         FROM academic_requests ar JOIN form_versions fv ON fv.id = ar.form_version_id
        WHERE ar.id = ? AND ar.requester_id = ? AND ar.deleted_at IS NULL`,
      [id, auth.id],
    );
    if (!r) throw AppException.of('ACADEMIC_REQUEST_NOT_FOUND');

    const schema: FormSchema = typeof r.schema === 'string' ? JSON.parse(r.schema) : r.schema;
    const answers: Record<string, unknown> = typeof r.answers === 'string' ? JSON.parse(r.answers) : (r.answers ?? {});
    const [attachments, wilayas, categories] = await Promise.all([
      em.query('SELECT a.file_id, f.original_name FROM academic_request_attachments a JOIN files f ON f.id = a.file_id WHERE a.request_id = ?', [id]),
      em.query('SELECT code, name FROM wilayas'),
      em.query('SELECT id, name_en FROM categories'),
    ]);
    const names = {
      wilayaNames: new Map<number, string>(wilayas.map((w: any) => [Number(w.code), w.name])),
      categoryNames: new Map<string, string>(categories.map((c: any) => [c.id, c.name_en])),
      fileNames: new Map<string, string>(attachments.map((a: any) => [a.file_id, a.original_name])),
    };

    return {
      ...this.toRow(r),
      answers: schema.fields
        .filter((field: FormField) => field.type !== 'section' && field.type !== 'info')
        .map((field: FormField) => ({
          key: field.key,
          type: field.type,
          labelEn: field.label_en,
          labelAr: field.label_ar,
          section: field.section ?? null,
          value: answers[field.key] ?? null,
          displayValue: displayValue(field, answers[field.key], names),
        })),
    };
  }
}

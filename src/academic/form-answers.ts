import type { FormField, FormSchema } from './entities/form-version.entity.js';
import { DISPLAY_TYPES, FILE_EXTENSIONS, FILE_MIME } from './form-schema.js';

/**
 * Server-side answer validation against a form version (ACR-07), the same
 * rules the builder configures. Pure: wilayas, categories and uploaded files
 * are passed in by the caller.
 */

export interface UploadedAnswerFile {
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
}

export interface AnswerContext {
  /** Today in Africa/Algiers, `YYYY-MM-DD`. */
  today: string;
  wilayaCodes: ReadonlySet<number>;
  categoryIds: ReadonlySet<string>;
  /** Files uploaded for each file field (already token-checked). */
  files: Readonly<Record<string, UploadedAnswerFile[]>>;
  /** Upper bound from `max_document_upload_mb`. */
  maxUploadMb: number;
}

export interface AnswerIssue {
  fieldKey: string;
  code: string;
}

export interface AnswerResult {
  /** Visible answers only; file fields hold the file ids. */
  answers: Record<string, unknown>;
  errors: AnswerIssue[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** E.164 or an Algerian national number (0 + 9 digits, mobiles 05/06/07). */
const PHONE = /^(\+[1-9]\d{7,14}|0[5-7]\d{8}|0[2-4]\d{7})$/;

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Whether a field is shown given the (already cleaned) earlier answers. */
export function isShown(field: FormField, answers: Record<string, unknown>, shown: ReadonlySet<string>): boolean {
  const condition = field.showIf as { field?: string; equals?: unknown; in?: unknown[]; notEmpty?: boolean } | undefined;
  if (!condition?.field) return true;
  if (!shown.has(condition.field)) return false;
  const value = answers[condition.field];
  if (condition.notEmpty) return !isEmpty(value);
  const matches = (candidate: unknown) => (Array.isArray(value) ? value.includes(candidate) : value === candidate);
  if (condition.equals !== undefined) return matches(condition.equals);
  if (Array.isArray(condition.in)) return condition.in.some(matches);
  return true;
}

export function validateAnswers(schema: FormSchema, input: unknown, ctx: AnswerContext): AnswerResult {
  const errors: AnswerIssue[] = [];
  const answers: Record<string, unknown> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { answers, errors: [{ fieldKey: '*', code: 'ANSWERS_NOT_OBJECT' }] };
  }
  const raw = input as Record<string, unknown>;
  const known = new Set(schema.fields.filter((f) => !DISPLAY_TYPES.includes(f.type)).map((f) => f.key));
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push({ fieldKey: key, code: 'UNKNOWN_FIELD' });
  for (const key of Object.keys(ctx.files)) if (!schema.fields.some((f) => f.key === key && f.type === 'file')) errors.push({ fieldKey: key, code: 'UNKNOWN_FIELD' });

  const shown = new Set<string>();
  for (const field of schema.fields) {
    if (DISPLAY_TYPES.includes(field.type)) continue;
    if (!isShown(field, answers, shown)) continue;
    shown.add(field.key);
    const fail = (code: string) => errors.push({ fieldKey: field.key, code });
    const v = (field.validation ?? {}) as Record<string, any>;

    if (field.type === 'file') {
      const files = ctx.files[field.key] ?? [];
      if (files.length === 0) {
        if (field.required) fail('REQUIRED');
        continue;
      }
      const maxFiles = v.maxFiles ?? 1;
      if (files.length > maxFiles) fail('TOO_MANY_FILES');
      const types = ((v.types as string[] | undefined) ?? [...FILE_EXTENSIONS]).map((t) => FILE_MIME[t as keyof typeof FILE_MIME]);
      if (files.some((f) => !types.includes(f.mimeType))) fail('FILE_TYPE_NOT_ALLOWED');
      const maxMb = Math.min(typeof v.maxSizeMb === 'number' ? v.maxSizeMb : ctx.maxUploadMb, ctx.maxUploadMb);
      if (files.some((f) => f.sizeBytes > maxMb * 1024 * 1024)) fail('FILE_TOO_LARGE');
      answers[field.key] = files.map((f) => f.fileId);
      continue;
    }

    let value = raw[field.key];
    if (typeof value === 'string') value = value.trim();
    if (isEmpty(value) || (field.type === 'consent' && value === false)) {
      if (field.required) fail(field.type === 'consent' ? 'CONSENT_REQUIRED' : 'REQUIRED');
      continue;
    }

    switch (field.type) {
      case 'short_text':
      case 'long_text': {
        if (typeof value !== 'string') {
          fail('TYPE_INVALID');
          break;
        }
        const max = v.maxLength ?? (field.type === 'short_text' ? 190 : 5000);
        if (typeof v.minLength === 'number' && value.length < v.minLength) fail('TOO_SHORT');
        else if (value.length > max) fail('TOO_LONG');
        else if (typeof v.pattern === 'string' && !new RegExp(v.pattern, 'u').test(value)) fail('PATTERN_MISMATCH');
        else answers[field.key] = value;
        break;
      }
      case 'email':
        if (typeof value !== 'string') fail('TYPE_INVALID');
        else if (!EMAIL.test(value) || value.length > 190) fail('EMAIL_INVALID');
        else answers[field.key] = value.toLowerCase();
        break;
      case 'phone': {
        if (typeof value !== 'string') {
          fail('TYPE_INVALID');
          break;
        }
        const compact = value.replace(/[\s.-]/g, '');
        if (!PHONE.test(compact)) fail('PHONE_INVALID');
        else answers[field.key] = compact;
        break;
      }
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('TYPE_INVALID');
        else if (v.integer && !Number.isInteger(value)) fail('NOT_INTEGER');
        else if (typeof v.min === 'number' && value < v.min) fail('BELOW_MIN');
        else if (typeof v.max === 'number' && value > v.max) fail('ABOVE_MAX');
        else answers[field.key] = value;
        break;
      case 'single_choice':
      case 'dropdown':
        if (typeof value !== 'string') fail('TYPE_INVALID');
        else if (!field.options?.some((o) => o.value === value)) fail('OPTION_INVALID');
        else answers[field.key] = value;
        break;
      case 'multi_choice':
      case 'service_categories': {
        if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
          fail('TYPE_INVALID');
          break;
        }
        const unique = [...new Set(value as string[])];
        const valid = field.type === 'multi_choice' ? (x: string) => !!field.options?.some((o) => o.value === x) : (x: string) => ctx.categoryIds.has(x);
        if (unique.some((x) => !valid(x))) fail(field.type === 'multi_choice' ? 'OPTION_INVALID' : 'CATEGORY_INVALID');
        else if (typeof v.minSelected === 'number' && unique.length < v.minSelected) fail('TOO_FEW');
        else if (typeof v.maxSelected === 'number' && unique.length > v.maxSelected) fail('TOO_MANY');
        else answers[field.key] = unique;
        break;
      }
      case 'date':
        if (typeof value !== 'string' || !validDate(value)) fail('DATE_INVALID');
        else if (typeof v.minOffsetDays === 'number' && value < addDays(ctx.today, v.minOffsetDays)) fail('DATE_TOO_EARLY');
        else if (typeof v.maxOffsetDays === 'number' && value > addDays(ctx.today, v.maxOffsetDays)) fail('DATE_TOO_LATE');
        else answers[field.key] = value;
        break;
      case 'time_range': {
        const t = value as { start?: unknown; end?: unknown };
        const keys = typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : null;
        if (!keys || keys.some((k) => k !== 'start' && k !== 'end') || typeof t.start !== 'string' || typeof t.end !== 'string' || !TIME.test(t.start) || !TIME.test(t.end)) fail('TIME_RANGE_INVALID');
        else if (t.end <= t.start) fail('TIME_RANGE_INVALID');
        else answers[field.key] = { start: t.start, end: t.end };
        break;
      }
      case 'wilaya':
        if (!Number.isInteger(value)) fail('TYPE_INVALID');
        else if (!ctx.wilayaCodes.has(value as number)) fail('WILAYA_INVALID');
        else answers[field.key] = value;
        break;
      case 'budget_range': {
        const b = value as { min?: unknown; max?: unknown };
        const keys = typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : null;
        const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
        if (!keys || keys.some((k) => k !== 'min' && k !== 'max') || !num(b.min) || !num(b.max) || (b.min as number) > (b.max as number)) fail('BUDGET_INVALID');
        else if (typeof v.min === 'number' && (b.min as number) < v.min) fail('BELOW_MIN');
        else if (typeof v.max === 'number' && (b.max as number) > v.max) fail('ABOVE_MAX');
        else answers[field.key] = { min: b.min, max: b.max };
        break;
      }
      case 'consent':
        if (value !== true) fail('CONSENT_REQUIRED');
        else answers[field.key] = true;
        break;
      default:
        break;
    }
  }
  return { answers, errors };
}

/** Keys whose values differ between two answer sets (ACR-02 "changed fields"). */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => stable(before?.[k] ?? null) !== stable(after?.[k] ?? null)).sort();
}

/** JSON with sorted object keys (MySQL JSON columns do not keep key order). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}


export interface MappedColumns {
  requesterName: string | null;
  requesterPhone: string | null;
  title: string | null;
  institutionName: string | null;
  eventType: string | null;
  eventDate: string | null;
  wilayaCode: number | null;
  attendees: number | null;
  budgetMin: string | null;
  budgetMax: string | null;
  /** Category ids of the `needs` field. */
  needs: string[];
}

/** Values of the system-mapped fields, copied onto `academic_requests` columns. */
export function mappedColumns(schema: FormSchema, answers: Record<string, unknown>, eventTypes: readonly string[]): MappedColumns {
  const value = (target: string): unknown => {
    const field = schema.fields.find((f) => f.maps_to === target);
    return field ? answers[field.key] : undefined;
  };
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const budget = value('budget') as { min?: number; max?: number } | undefined;
  const eventType = str(value('event_type'));
  return {
    requesterName: str(value('requester_name')),
    requesterPhone: str(value('requester_phone')),
    title: str(value('title')),
    institutionName: str(value('institution_name')),
    eventType: eventType && eventTypes.includes(eventType) ? eventType : null,
    eventDate: str(value('event_date')),
    wilayaCode: typeof value('wilaya') === 'number' ? (value('wilaya') as number) : null,
    attendees: typeof value('attendees') === 'number' ? Math.round(value('attendees') as number) : null,
    budgetMin: typeof budget?.min === 'number' ? budget.min.toFixed(2) : null,
    budgetMax: typeof budget?.max === 'number' ? budget.max.toFixed(2) : null,
    needs: Array.isArray(value('needs')) ? (value('needs') as string[]) : [],
  };
}

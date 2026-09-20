import { AcademicRequestStatus as S, FormStatus } from '../common/enums/academic.enums.js';

// ── academic requests (status-rules §7, admin actor) ─────────────

export const REQUEST_TABS = ['pending', 'changes_requested', 'approved', 'in_progress', 'rejected', 'completed', 'cancelled', 'all'] as const;
export type RequestTab = (typeof REQUEST_TABS)[number];

export type RequestAction = 'assign' | 'request_changes' | 'approve' | 'reject' | 'cancel' | 'propose' | 'book' | 'resubmit' | 'complete';

const FINAL: readonly S[] = [S.Rejected, S.Completed, S.Cancelled];
export const OPEN_STATUSES: readonly S[] = [S.Pending, S.ChangesRequested, S.Approved, S.InProgress];

const ALLOWED: Record<RequestAction, readonly S[]> = {
  assign: OPEN_STATUSES,
  request_changes: [S.Pending],
  approve: [S.Pending],
  reject: [S.Pending, S.ChangesRequested],
  cancel: OPEN_STATUSES,
  propose: OPEN_STATUSES,
  book: [S.Approved, S.InProgress],
  resubmit: [S.ChangesRequested],
  complete: [S.InProgress],
};

export function canDo(status: S, action: RequestAction): boolean {
  return ALLOWED[action].includes(status);
}

export function isFinal(status: S): boolean {
  return FINAL.includes(status);
}

/** Actions the detail screen (ACR-02) can show for this status. */
export function allowedRequestActions(status: S): RequestAction[] {
  return (['assign', 'request_changes', 'approve', 'reject', 'cancel', 'propose', 'book'] as RequestAction[]).filter((a) => canDo(status, a));
}

/**
 * in_progress → completed (job): at least one linked booking, every linked
 * booking completed or cancelled, and the last event day (request date and
 * booking dates) before today in Africa/Algiers.
 */
export function isDueForCompletion(input: { status: S; eventDate: string | null; bookings: { status: string; eventDate: string }[] }, today: string): boolean {
  if (input.status !== S.InProgress || input.bookings.length === 0) return false;
  if (input.bookings.some((b) => b.status !== 'completed' && b.status !== 'cancelled')) return false;
  const last = [input.eventDate, ...input.bookings.map((b) => b.eventDate)].filter((d): d is string => !!d).sort().at(-1)!;
  return last < today;
}

/** Monthly limit per email per form: the current UTC calendar month. */
export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ── forms ───────────────────────────────────────────────────────

export const FORM_TABS = ['draft', 'published', 'closed', 'all'] as const;
export type FormTab = (typeof FORM_TABS)[number];

export type FormAction = 'publish' | 'close' | 'reopen';

const FORM_MOVES: Record<FormAction, readonly FormStatus[]> = {
  publish: [FormStatus.Draft, FormStatus.Published],
  close: [FormStatus.Published],
  reopen: [FormStatus.Closed],
};

export function canFormDo(status: FormStatus, action: FormAction): boolean {
  return FORM_MOVES[action].includes(status);
}

/** `Science Day 2026 — Alger` → `science-day-2026-alger` (max 80). */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return slug || 'form';
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const EDIT_LINK_TTL_DAYS = 14;
export const UPLOAD_TOKEN_TTL_SECONDS = 3600;
export const FORM_CODE_TTL_MINUTES = 15;
export const FORM_CODE_RESEND_SECONDS = 60;
export const FORM_CODE_MAX_ATTEMPTS = 5;

import { AppException } from '../common/errors/app.exception.js';
import type { Lang } from '../common/i18n/language.js';
import { fromCents, toCents } from '../services/services.policy.js';

/** How many budget lines one client may keep (screen 18 shows a handful). */
export const BUDGET_MAX_ITEMS = 60;

/** Page size of the recent reviews embedded in a service / provider detail. */
export const EMBEDDED_REVIEWS = 3;

/** Home (screen 11) block sizes. */
export const HOME_UPCOMING_BOOKINGS = 2;
export const HOME_PACKS = 6;
export const HOME_SERVICES = 10;

/**
 * Bilingual text in the caller's language, falling back to the other one
 * (tech-decisions → Languages: `Accept-Language`, then the user's `language`,
 * then `en`). A column that is empty never wins, so a half-translated row still
 * shows something rather than an empty string.
 */
export function pickText(lang: Lang, en: string | null | undefined, ar: string | null | undefined): string {
  const preferred = lang === 'ar' ? ar : en;
  const other = lang === 'ar' ? en : ar;
  const clean = (value: string | null | undefined) => (typeof value === 'string' && value.trim() !== '' ? value : null);
  return clean(preferred) ?? clean(other) ?? '';
}

/** `pickText` for a nullable field: null when neither language has text. */
export function pickTextOrNull(lang: Lang, en: string | null | undefined, ar: string | null | undefined): string | null {
  const value = pickText(lang, en, ar);
  return value === '' ? null : value;
}

/**
 * The budget is private to its owner (api-standards §4 Privacy): nobody else —
 * not another client, not an admin — can read or write it through the app API.
 * Throws 403 NOT_OWNER otherwise.
 */
export function assertBudgetOwner(budgetClientId: string, callerId: string): void {
  if (budgetClientId !== callerId) {
    throw AppException.of('NOT_OWNER');
  }
}

export interface BudgetLine {
  plannedAmount: string;
  spentAmount: string;
  bookingId: string | null;
}

export interface BudgetTotals {
  planned: string;
  spent: string;
  remaining: string;
  /** `spent / totalAmount` as a percentage, 0 when no total is set. */
  spentPercent: number;
  itemsCount: number;
  bookedCount: number;
}

/** Screen 18 header: spent / planned, remaining against the declared total. */
export function budgetTotals(totalAmount: string, items: BudgetLine[]): BudgetTotals {
  const planned = items.reduce((sum, item) => sum + toCents(item.plannedAmount), 0);
  const spent = items.reduce((sum, item) => sum + toCents(item.spentAmount), 0);
  const total = toCents(totalAmount);
  return {
    planned: fromCents(planned),
    spent: fromCents(spent),
    remaining: fromCents(total - spent),
    spentPercent: total > 0 ? Math.round((spent / total) * 1000) / 10 : 0,
    itemsCount: items.length,
    bookedCount: items.filter((item) => item.bookingId !== null).length,
  };
}

/** `YYYY-MM` guard for the availability endpoints (400 MONTH_INVALID). */
export function parseMonth(month: string): { year: number; month: number; first: string; last: string; days: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw AppException.of('MONTH_INVALID', { month });
  }
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { year, month: mon, first: `${month}-01`, last: `${month}-${String(days).padStart(2, '0')}`, days };
}

export const DAY_STATES = ['available', 'busy', 'blocked'] as const;
export type DayState = (typeof DAY_STATES)[number];

/**
 * Screen 12 / 20 calendar: a day is `blocked` when the provider blocked it by
 * hand, `busy` when held and booked events already fill `maxEventsPerDay`, and
 * `available` otherwise. Past days are `blocked` — nothing can be booked there.
 */
export function dayState(input: { past: boolean; manualBlock: boolean; taken: number; capacity: number }): DayState {
  if (input.past || input.manualBlock) return 'blocked';
  return input.taken >= Math.max(1, input.capacity) ? 'busy' : 'available';
}

/** Rating histogram (screen 12 "rating breakdown"), always five buckets. */
export function ratingBreakdown(counts: { rating: number; n: number }[]): { stars: number; count: number; percent: number }[] {
  const total = counts.reduce((sum, row) => sum + row.n, 0);
  return [5, 4, 3, 2, 1].map((stars) => {
    const count = counts.find((row) => row.rating === stars)?.n ?? 0;
    return { stars, count, percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0 };
  });
}

/** "Usually replies in …" from `provider_profiles.avg_reply_minutes`. */
export function replyTimeLabel(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

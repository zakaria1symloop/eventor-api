import { FileVariantKind } from '../common/enums/file.enums.js';
import { DocumentRejectReason, DocumentType } from '../common/enums/file.enums.js';
import { PriceType } from '../common/enums/catalog.enums.js';
import type { Lang } from '../common/i18n/language.js';
import type { FilesService } from '../files/files.service.js';
import { pickText } from './app.policy.js';
import type { AppCategoryRefDto, AppWilayaRefDto } from './dto/app-me.dto.js';

/** Rows the list queries select for a wilaya / category, whatever the alias. */
export interface WilayaRow {
  code: number | string;
  name: string;
  name_ar: string;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
  icon: string;
}

export function toWilayaRef(lang: Lang, row: WilayaRow | null | undefined): AppWilayaRefDto | null {
  if (!row || row.code === null || row.code === undefined) return null;
  return {
    code: Number(row.code),
    name: pickText(lang, row.name, row.name_ar),
    nameEn: row.name,
    nameAr: row.name_ar,
  };
}

export function toCategoryRef(lang: Lang, row: CategoryRow | null | undefined): AppCategoryRefDto | null {
  if (!row?.id) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: pickText(lang, row.name_en, row.name_ar),
    nameEn: row.name_en,
    nameAr: row.name_ar,
    icon: row.icon,
  };
}

/** Photo URLs of a file id: always the three variants the app lays out with. */
export function photoUrls(files: FilesService, fileId: string) {
  return {
    thumbUrl: files.signedUrl(fileId, { variant: FileVariantKind.Thumb }),
    mediumUrl: files.signedUrl(fileId, { variant: FileVariantKind.Medium }),
    largeUrl: files.signedUrl(fileId),
  };
}

export function avatarUrl(files: FilesService, fileId: string | null | undefined, variant?: FileVariantKind): string | null {
  return fileId ? files.signedUrl(fileId, variant ? { variant } : {}) : null;
}

/** "From 45 000 DA **per day**" — the price type in the caller's language. */
const PRICE_TYPE_LABELS: Record<PriceType, { en: string; ar: string }> = {
  [PriceType.PerEvent]: { en: 'per event', ar: 'لكل مناسبة' },
  [PriceType.PerHour]: { en: 'per hour', ar: 'لكل ساعة' },
  [PriceType.PerPerson]: { en: 'per person', ar: 'لكل شخص' },
  [PriceType.PerDay]: { en: 'per day', ar: 'لكل يوم' },
  [PriceType.OnQuote]: { en: 'on quote', ar: 'حسب الطلب' },
};

export function priceTypeLabel(lang: Lang, priceType: PriceType): string {
  const entry = PRICE_TYPE_LABELS[priceType] ?? PRICE_TYPE_LABELS[PriceType.PerEvent];
  return lang === 'ar' ? entry.ar : entry.en;
}

/** Document names as screens 08a / 08d print them. */
const DOCUMENT_LABELS: Record<DocumentType, { en: string; ar: string }> = {
  [DocumentType.NationalId]: { en: 'National ID card', ar: 'بطاقة التعريف الوطنية' },
  [DocumentType.CommercialRegisterOrArtisanCard]: { en: 'Commercial register or artisan card', ar: 'السجل التجاري أو بطاقة الحرفي' },
  [DocumentType.TaxCard]: { en: 'Tax registration card (NIF)', ar: 'بطاقة التعريف الجبائي' },
};

export function documentLabel(lang: Lang, type: DocumentType): string {
  const entry = DOCUMENT_LABELS[type];
  return lang === 'ar' ? entry.ar : entry.en;
}

/** The reject reason shown to the provider (api-decisions: "Arabic copy for each value"). */
const REJECT_REASON_LABELS: Record<DocumentRejectReason, { en: string; ar: string }> = {
  [DocumentRejectReason.Unreadable]: { en: 'The document is not readable', ar: 'الوثيقة غير واضحة' },
  [DocumentRejectReason.Expired]: { en: 'The document has expired', ar: 'انتهت صلاحية الوثيقة' },
  [DocumentRejectReason.NameMismatch]: { en: 'Details do not match the account', ar: 'المعلومات لا تطابق الحساب' },
  [DocumentRejectReason.WrongDocument]: { en: 'This is not the document we asked for', ar: 'هذه ليست الوثيقة المطلوبة' },
  [DocumentRejectReason.Other]: { en: 'Another problem', ar: 'مشكلة أخرى' },
};

export function rejectReasonLabel(lang: Lang, reason: DocumentRejectReason | null): string | null {
  if (!reason) return null;
  const entry = REJECT_REASON_LABELS[reason];
  return lang === 'ar' ? entry.ar : entry.en;
}

/**
 * A reviewer's display name: first name plus the initial of the next word
 * ("Yasmine K."), so a review never leaks a full identity (api-standards §4).
 */
export function reviewerName(fullName: string | null | undefined): string {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Eventor user';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[1]![0]!.toUpperCase()}.`;
}

/** `HH:mm` from a MySQL `time` value. */
export const hhmm = (value: string | null | undefined): string | null => (value ? String(value).slice(0, 5) : null);

import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator.js';
import { AppException } from '../common/errors/app.exception.js';
import { ReqLang } from '../common/i18n/lang.decorator.js';
import type { Lang } from '../common/i18n/language.js';
import { ApiDataResponse } from '../common/swagger/api-data-response.decorator.js';
import { ApiErrorResponses } from '../common/swagger/api-error-responses.decorator.js';
import { envConfig, type Env } from '../config/env.js';
import { SettingsService } from '../settings/settings.service.js';
import { LEGAL_DRAFT_DATE } from './legal-drafts.js';

export const LEGAL_DOCS = ['terms', 'privacy'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

const TITLES: Record<LegalDoc, Record<Lang, string>> = {
  terms: { en: 'Terms of Use', ar: 'شروط الاستخدام' },
  privacy: { en: 'Privacy Policy', ar: 'سياسة الخصوصية' },
};

/** The public pages of the dashboard site (also the app's fallback `termsUrl` / `privacyUrl` / `deleteAccountUrl`). */
export const legalPageUrl = (adminUrl: string, lang: Lang, page: LegalDoc | 'delete-account'): string =>
  `${adminUrl.replace(/\/+$/, '')}/${lang}/${page === 'delete-account' ? 'delete-account' : `legal/${page}`}`;

export class PublicLegalDto {
  @ApiProperty({ enum: LEGAL_DOCS }) doc: LegalDoc;
  @ApiProperty({ enum: ['en', 'ar'] }) lang: Lang;
  @ApiProperty({ example: 'Privacy Policy' }) title: string;
  @ApiProperty({ description: 'Markdown-lite: `## ` headings, `- ` bullets, blank lines between paragraphs, `**bold**`.' }) body: string;
  @ApiProperty({ format: 'date-time', description: 'When an admin last changed it (the draft date until then).' }) updatedAt: string;
}

/**
 * The Terms of Use and the Privacy Policy, edited by admins in Settings · Legal,
 * for the public pages `/{lang}/legal/terms` and `/{lang}/legal/privacy` that the
 * store listings and the app link to. No token.
 */
@ApiTags('public-legal')
@Public()
@Controller('public/legal')
export class LegalController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(envConfig.KEY) private readonly env: Env,
    private readonly settings: SettingsService,
  ) {}

  @Get(':doc')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Terms of Use or Privacy Policy', description: 'Public. In the `Accept-Language` language (en / ar).' })
  @ApiParam({ name: 'doc', enum: LEGAL_DOCS })
  @ApiDataResponse(PublicLegalDto)
  @ApiErrorResponses('NOT_FOUND', 'RATE_LIMITED')
  async get(@Param('doc') doc: string, @ReqLang() lang: Lang) {
    if (!(LEGAL_DOCS as readonly string[]).includes(doc)) throw AppException.of('NOT_FOUND');
    const key = `legal_${doc}_${lang}` as 'legal_terms_en';
    const values = await this.settings.getMany([key, 'support_email', 'support_phone', 'invoice_issuer'] as const);
    const [row] = await this.dataSource.query('SELECT updated_at FROM settings WHERE `key` = ?', [key]);
    const contact = [values.support_email, values.support_phone].filter((v) => v && v.trim() !== '').join(' · ');
    const supportContact =
      contact || (lang === 'ar' ? 'عبر مراسلة دعم Eventor داخل التطبيق' : 'by sending a message to Eventor support in the app');
    const issuer = values.invoice_issuer;
    const operator = [issuer?.name || 'Eventor', issuer?.address, issuer?.email, issuer?.phone].filter((v) => v && v.trim() !== '').join(', ');
    const body = String(values[key] ?? '')
      .replaceAll('{deleteAccountUrl}', legalPageUrl(this.env.ADMIN_URL, lang, 'delete-account'))
      .replaceAll('{supportContact}', supportContact)
      .replaceAll('{operator}', operator);
    const data: PublicLegalDto = {
      doc: doc as LegalDoc,
      lang,
      title: TITLES[doc as LegalDoc][lang],
      body,
      updatedAt: new Date(row?.updated_at ?? `${LEGAL_DRAFT_DATE}T00:00:00.000Z`).toISOString(),
    };
    return { data };
  }
}

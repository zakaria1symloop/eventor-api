import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { dateOnly } from '../bookings/bookings.service.js';
import { likeContains } from '../common/dto/transforms.js';
import { normalisePhone } from '../users/users.policy.js';
import type { ExactMatchDto, SearchGroupDto, SearchGroupType, SearchItemDto, SearchQueryDto, SearchResultDto } from './dto/search.dto.js';

/** Dashboard routes for the "pages" group (admin-dashboard-screen-map.md). */
export const DASHBOARD_PAGES: { key: string; en: string; ar: string; href: string; keywords: string[] }[] = [
  { key: 'overview', en: 'Overview', ar: 'نظرة عامة', href: '/', keywords: ['dashboard', 'home', 'kpi', 'statistics', 'الرئيسية', 'إحصائيات'] },
  { key: 'users', en: 'Users', ar: 'المستخدمون', href: '/users', keywords: ['clients', 'providers', 'accounts', 'العملاء', 'مقدمو الخدمات', 'حسابات'] },
  { key: 'add-user', en: 'Add user', ar: 'إضافة مستخدم', href: '/users?new=1', keywords: ['new user', 'create client', 'create provider', 'مستخدم جديد'] },
  { key: 'verifications', en: 'Verifications', ar: 'التحقق', href: '/verifications?tab=waiting', keywords: ['documents', 'kyc', 'id card', 'الوثائق', 'التحقق من الهوية'] },
  { key: 'services', en: 'Services', ar: 'الخدمات', href: '/services', keywords: ['listings', 'catalogue', 'قائمة الخدمات'] },
  { key: 'packs', en: 'Ready packs', ar: 'الباقات الجاهزة', href: '/packs', keywords: ['packages', 'bundles', 'باقات'] },
  { key: 'bookings', en: 'Bookings', ar: 'الحجوزات', href: '/bookings', keywords: ['reservations', 'orders', 'invoices', 'حجز', 'فواتير'] },
  { key: 'bookings-no-reply', en: 'Bookings without a reply', ar: 'حجوزات بدون رد', href: '/bookings?tab=pending&noReply=true', keywords: ['no reply', 'pending', 'بدون رد'] },
  { key: 'disputes', en: 'Disputes', ar: 'النزاعات', href: '/disputes?tab=open', keywords: ['complaints', 'conflicts', 'شكاوى', 'نزاع'] },
  { key: 'academic-requests', en: 'Academic requests', ar: 'الطلبات الأكاديمية', href: '/academic-requests', keywords: ['university', 'conference', 'جامعة', 'مؤتمر'] },
  { key: 'forms', en: 'Request forms', ar: 'نماذج الطلبات', href: '/academic-requests/forms', keywords: ['form builder', 'نموذج'] },
  { key: 'reviews', en: 'Reviews', ar: 'التقييمات', href: '/reviews', keywords: ['ratings', 'reported reviews', 'moderation', 'تقييم', 'مراجعات'] },
  { key: 'reported-reviews', en: 'Reported reviews', ar: 'التقييمات المبلغ عنها', href: '/reviews?tab=reported', keywords: ['reports', 'flagged', 'بلاغات'] },
  { key: 'messages', en: 'Messages', ar: 'الرسائل', href: '/messages', keywords: ['inbox', 'chat', 'conversations', 'المحادثات', 'دردشة'] },
  { key: 'categories', en: 'Categories', ar: 'الفئات', href: '/categories', keywords: ['category', 'فئة'] },
  { key: 'locations', en: 'Locations', ar: 'المواقع', href: '/locations', keywords: ['wilayas', 'communes', 'الولايات', 'البلديات'] },
  { key: 'settings', en: 'Settings', ar: 'الإعدادات', href: '/settings', keywords: ['configuration', 'fees', 'notifications settings', 'إعدادات'] },
  { key: 'admins', en: 'Admins', ar: 'المشرفون', href: '/settings/admins', keywords: ['invite admin', 'team', 'دعوة مشرف', 'فريق'] },
  { key: 'activity-log', en: 'Activity log', ar: 'سجل النشاط', href: '/activity-log', keywords: ['audit', 'history', 'logs', 'السجل'] },
  { key: 'account', en: 'My account', ar: 'حسابي', href: '/account', keywords: ['profile', 'password', 'sessions', 'كلمة المرور', 'الملف الشخصي'] },
];

const REFERENCE = /^#?(EVT|ACR|DSP)-\d{1,8}$/i;
const INVOICE = /^#?INV-\d{4}-\d{1,8}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ًͯ-ْـ]/g, '');

/** SHL-01: global search across users, services, bookings, academic requests, disputes and dashboard pages. */
@Injectable()
export class SearchService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async search(query: SearchQueryDto): Promise<SearchResultDto> {
    const q = query.q.trim();
    const scope = query.scope ?? 'all';
    const limit = query.limit ?? 5;
    const bare = q.replace(/^#/, '');
    const reference = REFERENCE.test(q) || INVOICE.test(q) ? bare.toUpperCase() : null;
    const email = EMAIL.test(q) ? q.toLowerCase() : null;
    const phone = normalisePhone(q);
    const like = likeContains(reference ?? q);

    const wanted = (type: SearchGroupType) => scope === 'all' || scope === type;
    // A reference (EVT-…, INV-…) cannot be part of a name or a title: skip those scans.
    const fetchers: [SearchGroupType, () => Promise<SearchItemDto[]> | SearchItemDto[]][] = [
      ['users', () => (reference ? [] : this.users(q, like, email, phone, limit))],
      ['services', () => (reference ? [] : this.services(like, limit))],
      ['bookings', () => this.bookings(like, reference, limit)],
      ['requests', () => this.requests(like, reference, limit)],
      ['disputes', () => this.disputes(like, reference, limit)],
      ['pages', () => this.pages(q, limit)],
    ];

    // Groups run concurrently (one pooled connection each) and keep their fixed order.
    const [exactMatch, ...groups] = await Promise.all([
      this.exactMatch(reference, email, phone),
      ...fetchers.filter(([type]) => wanted(type)).map(async ([type, fetch]): Promise<SearchGroupDto> => ({ type, items: await fetch() })),
    ]);

    return { q, exactMatch, groups: groups as SearchGroupDto[] };
  }

  private async exactMatch(reference: string | null, email: string | null, phone: string | null): Promise<ExactMatchDto | null> {
    const one = async (sql: string, value: string) => ((await this.dataSource.query(sql, [value])) as any[])[0] ?? null;
    if (reference?.startsWith('EVT-')) {
      const r = await one('SELECT id FROM bookings WHERE reference = ? AND deleted_at IS NULL', reference);
      return r ? { type: 'booking', id: r.id, href: `/bookings/${r.id}` } : null;
    }
    if (reference?.startsWith('ACR-')) {
      const r = await one('SELECT id FROM academic_requests WHERE reference = ? AND deleted_at IS NULL', reference);
      return r ? { type: 'academic_request', id: r.id, href: `/academic-requests/${r.id}` } : null;
    }
    if (reference?.startsWith('DSP-')) {
      const r = await one('SELECT id FROM disputes WHERE reference = ? AND deleted_at IS NULL', reference);
      return r ? { type: 'dispute', id: r.id, href: `/disputes/${r.id}` } : null;
    }
    if (reference?.startsWith('INV-')) {
      const r = await one('SELECT i.id, i.booking_id FROM invoices i JOIN bookings b ON b.id = i.booking_id AND b.deleted_at IS NULL WHERE i.number = ? AND i.deleted_at IS NULL ORDER BY i.version DESC LIMIT 1', reference);
      return r ? { type: 'invoice', id: r.id, href: `/bookings/${r.booking_id}/invoice` } : null;
    }
    const user = email
      ? await one("SELECT id FROM users WHERE email = ? AND role <> 'admin' AND deleted_at IS NULL", email)
      : phone
        ? await one("SELECT id FROM users WHERE phone = ? AND role <> 'admin' AND deleted_at IS NULL", phone)
        : null;
    return user ? { type: 'user', id: user.id, href: `/users/${user.id}` } : null;
  }

  private async users(q: string, like: string, email: string | null, phone: string | null, limit: number): Promise<SearchItemDto[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.verification_status, pp.business_name,
              (u.email = ? OR u.phone = ?) AS exact
       FROM users u LEFT JOIN provider_profiles pp ON pp.user_id = u.id
       WHERE u.deleted_at IS NULL AND u.role <> 'admin'
         AND (u.full_name LIKE ? OR u.email LIKE ? OR u.id IN (SELECT qpp.user_id FROM provider_profiles qpp WHERE qpp.business_name LIKE ?) OR u.email = ? OR u.phone = ?)
       ORDER BY exact DESC, (u.full_name LIKE ?) DESC, u.full_name ASC LIMIT ?`,
      [email ?? '', phone ?? '', like, like, like, email ?? '', phone ?? '', `${likeContains(q).slice(1)}`, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.full_name,
      subtitle: [r.role === 'provider' ? (r.business_name ?? 'Provider') : 'Client', r.email].filter(Boolean).join(' · '),
      href: `/users/${r.id}`,
      badge: r.status === 'blocked' ? 'blocked' : r.role === 'provider' && r.verification_status !== 'verified' ? r.verification_status : r.role,
    }));
  }

  private async services(like: string, limit: number): Promise<SearchItemDto[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT s.id, s.title_en, s.title_ar, s.status, COALESCE(pp.business_name, u.full_name) AS provider
       FROM services s JOIN users u ON u.id = s.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = s.provider_id
       WHERE s.deleted_at IS NULL AND (s.title_en LIKE ? OR s.title_ar LIKE ? OR s.provider_id IN (SELECT qpp.user_id FROM provider_profiles qpp WHERE qpp.business_name LIKE ?))
       ORDER BY s.title_en ASC LIMIT ?`,
      [like, like, like, limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.title_en, subtitle: r.provider, href: `/services/${r.id}`, badge: r.status }));
  }

  private async bookings(like: string, reference: string | null, limit: number): Promise<SearchItemDto[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT b.id, b.reference, b.status, b.event_date, cu.full_name AS client, COALESCE(pp.business_name, pu.full_name) AS provider
       FROM bookings b JOIN users cu ON cu.id = b.client_id JOIN users pu ON pu.id = b.provider_id LEFT JOIN provider_profiles pp ON pp.user_id = b.provider_id
       WHERE b.deleted_at IS NULL AND ${
         reference
           ? // Reference prefix (unique index range) or the invoice number.
             '(b.reference LIKE ? OR b.id IN (SELECT i.booking_id FROM invoices i WHERE i.number = ?))'
             // Text: id subqueries, each table scanned once instead of once per booking.
           : '(b.reference LIKE ? OR b.client_id IN (SELECT qcu.id FROM users qcu WHERE qcu.full_name LIKE ?) OR b.provider_id IN (SELECT qpp.user_id FROM provider_profiles qpp WHERE qpp.business_name LIKE ?))'
       }
       ORDER BY (b.reference = ?) DESC, b.created_at DESC LIMIT ?`,
      reference
        ? [`${reference}%`, reference, reference, limit]
        : [like, like, like, '', limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.reference, subtitle: `${r.client} → ${r.provider} · ${dateOnly(r.event_date)}`, href: `/bookings/${r.id}`, badge: r.status }));
  }

  private async requests(like: string, reference: string | null, limit: number): Promise<SearchItemDto[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT id, reference, title, requester_name, institution_name, status FROM academic_requests
       WHERE deleted_at IS NULL AND (reference LIKE ? OR title LIKE ? OR requester_name LIKE ? OR institution_name LIKE ?)
       ORDER BY (reference = ?) DESC, submitted_at DESC LIMIT ?`,
      [like, like, like, like, reference ?? '', limit],
    );
    return rows.map((r) => ({ id: r.id, title: `${r.reference} · ${r.title}`, subtitle: [r.requester_name, r.institution_name].filter(Boolean).join(' · '), href: `/academic-requests/${r.id}`, badge: r.status }));
  }

  private async disputes(like: string, reference: string | null, limit: number): Promise<SearchItemDto[]> {
    const rows: any[] = await this.dataSource.query(
      `SELECT d.id, d.reference, d.status, d.type, b.reference AS booking_reference, ou.full_name AS opener, au.full_name AS against
       FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN users ou ON ou.id = d.opened_by_id JOIN users au ON au.id = d.against_user_id
       WHERE d.deleted_at IS NULL AND (d.reference LIKE ? OR b.reference LIKE ? OR ou.full_name LIKE ? OR au.full_name LIKE ?)
       ORDER BY (d.reference = ?) DESC, d.created_at DESC LIMIT ?`,
      [like, like, like, like, reference ?? '', limit],
    );
    return rows.map((r) => ({ id: r.id, title: `${r.reference} · ${String(r.type).replace(/_/g, ' ')}`, subtitle: `${r.opener} vs ${r.against} · ${r.booking_reference}`, href: `/disputes/${r.id}`, badge: r.status }));
  }

  private pages(q: string, limit: number): SearchItemDto[] {
    const needle = fold(q);
    return DASHBOARD_PAGES.filter((p) => [p.en, p.ar, ...p.keywords].some((text) => fold(text).includes(needle)))
      .slice(0, limit)
      .map((p) => ({ id: p.key, title: p.en, subtitle: p.ar, href: p.href, badge: null }));
  }
}

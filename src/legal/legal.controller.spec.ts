import { describe, expect, it, vi } from 'vitest';
import { LegalController, legalPageUrl } from './legal.controller.js';
import { PRIVACY_AR, PRIVACY_EN, TERMS_EN } from './legal-drafts.js';

function controller(values: Record<string, string>, updatedAt: Date | null = null) {
  const settings = { getMany: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, values[k] ?? '']))) };
  const dataSource = { query: vi.fn(async () => (updatedAt ? [{ updated_at: updatedAt }] : [])) };
  return new LegalController(dataSource as any, { ADMIN_URL: 'https://admin.eventor.dz/' } as any, settings as any);
}

describe('LegalController', () => {
  it('serves the text in the request language with the links filled in', async () => {
    const res = await controller({ legal_privacy_en: PRIVACY_EN, legal_privacy_ar: PRIVACY_AR }).get('privacy', 'en');
    expect(res.data).toMatchObject({ doc: 'privacy', lang: 'en', title: 'Privacy Policy', updatedAt: '2026-10-15T00:00:00.000Z' });
    expect(res.data.body).toContain('https://admin.eventor.dz/en/delete-account');
    expect(res.data.body).toContain('by sending a message to Eventor support in the app');
    expect(res.data.body).not.toMatch(/\{(deleteAccountUrl|supportContact)\}/);
    const ar = await controller({ legal_privacy_ar: PRIVACY_AR }).get('privacy', 'ar');
    expect(ar.data.title).toBe('سياسة الخصوصية');
    expect(ar.data.body).toContain('https://admin.eventor.dz/ar/delete-account');
  });

  it('uses the support contact once it is set, and the date of the last edit', async () => {
    const edited = new Date('2026-11-02T09:30:00Z');
    const res = await controller({ legal_terms_en: TERMS_EN, support_email: 'help@eventor.dz', support_phone: '+213 555 12 34 56' }, edited).get('terms', 'en');
    expect(res.data.body).toContain('help@eventor.dz · +213 555 12 34 56');
    expect(res.data.updatedAt).toBe(edited.toISOString());
  });

  it('answers 404 for any other page', async () => {
    await expect(controller({}).get('cookies', 'en')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('builds the public page URLs', () => {
    expect(legalPageUrl('https://admin.eventor.dz/', 'ar', 'terms')).toBe('https://admin.eventor.dz/ar/legal/terms');
    expect(legalPageUrl('https://admin.eventor.dz', 'en', 'delete-account')).toBe('https://admin.eventor.dz/en/delete-account');
  });
});

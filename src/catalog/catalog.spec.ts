import { AppException } from '../common/errors/app.exception.js';
import {
  assertWilayaCloseConfirmed,
  communeKey,
  deletedSlug,
  hasMissingTranslation,
  reorderPositions,
  slugify,
  SLUG_PATTERN,
} from './catalog.policy.js';
import { COMMUNES_CSV_TEMPLATE, parseCommunesCsv, parseCsvRecords } from './communes-csv.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return { code: (error as AppException).code, details: (error as AppException).details };
  }
};

describe('parseCsvRecords', () => {
  it('handles quotes, escaped quotes, commas and line breaks inside quotes', () => {
    const records = parseCsvRecords('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n');
    expect(records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['x, y', 'say "hi"'] },
      { line: 3, fields: ['multi\nline', 'z'] },
    ]);
  });

  it('strips the BOM, skips blank lines and keeps line numbers', () => {
    const records = parseCsvRecords('\uFEFFh1,h2\n\n1,2\r\n\r\n3,4');
    expect(records).toEqual([
      { line: 1, fields: ['h1', 'h2'] },
      { line: 3, fields: ['1', '2'] },
      { line: 5, fields: ['3', '4'] },
    ]);
  });
});

describe('parseCommunesCsv', () => {
  it('parses the template', () => {
    const result = parseCommunesCsv(COMMUNES_CSV_TEMPLATE);
    expect(result).toEqual({
      ok: true,
      errors: [],
      rows: [
        { line: 2, wilayaCode: 16, name: 'Bab El Oued', nameAr: 'باب الوادي', postalCode: '16009' },
        { line: 3, wilayaCode: 31, name: 'Bir El Djir', nameAr: 'بئر الجير', postalCode: '31130' },
      ],
    });
  });

  it('accepts a header without postal_code and a case/space-insensitive header', () => {
    const result = parseCommunesCsv(' Wilaya_Code , NAME,name_ar\n5,Batna,باتنة\n');
    expect(result).toMatchObject({ ok: true, rows: [{ wilayaCode: 5, name: 'Batna', postalCode: null }] });
  });

  it('rejects a wrong header', () => {
    expect(parseCommunesCsv('code,name,name_ar\n16,A,ب')).toEqual({ ok: false, reason: 'header', received: ['code', 'name', 'name_ar'] });
    expect(parseCommunesCsv('')).toMatchObject({ ok: false, reason: 'header' });
  });

  it('rejects files over the row limit', () => {
    const body = Array.from({ length: 4 }, (_, i) => `16,C${i},ب${i}`).join('\n');
    expect(parseCommunesCsv(`wilaya_code,name,name_ar\n${body}`, 3)).toEqual({ ok: false, reason: 'too_many_rows', count: 4 });
  });

  it('reports each bad line with its number and keeps the good ones', () => {
    const csv = [
      'wilaya_code,name,name_ar,postal_code',
      '16,Hydra,حيدرة,16035',
      'x,Nowhere,مكان,',
      '16,,,123',
      '16,"Too, many",كثير,16000,extra',
      `31,${'n'.repeat(121)},وهران,`,
    ].join('\n');
    const result = parseCommunesCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.name)).toEqual(['Hydra']);
    expect(result.errors).toEqual([
      { line: 3, message: 'wilaya_code must be a wilaya number' },
      { line: 4, message: 'name is required; name_ar is required; postal_code must have 5 digits' },
      { line: 5, message: 'expected 4 columns, got 5' },
      { line: 6, message: 'name must be at most 120 characters' },
    ]);
  });
});

describe('catalog policy', () => {
  it('slugifies names to ASCII kebab-case', () => {
    expect(slugify('Salles des fêtes')).toBe('salles-des-fetes');
    expect(slugify('  DJ & Sono!! ')).toBe('dj-sono');
    expect(slugify('قاعات')).toBe('category');
    expect(SLUG_PATTERN.test(slugify('a'.repeat(200)))).toBe(true);
  });

  it('frees the slug of deleted categories without breaking the length limit', () => {
    const slug = deletedSlug('x'.repeat(80), '7c4a1f0e-2b6d-4e8a-9c3f-1d2e3f4a5b6c');
    expect(slug).toHaveLength(80);
    expect(slug.endsWith('~7c4a1f0e')).toBe(true);
    expect(SLUG_PATTERN.test(slug)).toBe(false);
  });

  it('flags missing translations', () => {
    const base = { nameEn: 'Photo', nameAr: 'تصوير', descriptionEn: null, descriptionAr: null };
    expect(hasMissingTranslation(base)).toBe(false);
    expect(hasMissingTranslation({ ...base, nameAr: ' ' })).toBe(true);
    expect(hasMissingTranslation({ ...base, descriptionEn: 'Weddings' })).toBe(true);
    expect(hasMissingTranslation({ ...base, descriptionEn: 'Weddings', descriptionAr: 'أعراس' })).toBe(false);
  });

  it('reorders into the slots the ids occupy', () => {
    const current = [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
      { id: 'd', position: 3 },
    ];
    expect(reorderPositions(current, ['c', 'a', 'b', 'd'])).toEqual([
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ]);
    // A filtered tab (b, d) only swaps its own slots.
    expect(reorderPositions(current, ['d', 'b'])).toEqual([
      { id: 'd', position: 1 },
      { id: 'b', position: 3 },
    ]);
    expect(codeOf(() => reorderPositions(current, ['a', 'zz']))).toEqual({ code: 'CATEGORY_NOT_FOUND', details: { ids: ['zz'] } });
  });

  it('spreads duplicate positions', () => {
    const current = [
      { id: 'a', position: 0 },
      { id: 'b', position: 0 },
    ];
    // b keeps slot 0 (unchanged, not returned), a moves to 1.
    expect(reorderPositions(current, ['b', 'a'])).toEqual([{ id: 'a', position: 1 }]);
  });

  it('asks to confirm only when closing an open wilaya', () => {
    const input = { wasOpen: true, isOpen: false, confirm: undefined, servicesCount: 4, providersCount: 2 };
    expect(codeOf(() => assertWilayaCloseConfirmed(input))).toEqual({
      code: 'WILAYA_CLOSE_CONFIRM_REQUIRED',
      details: { servicesCount: 4, providersCount: 2 },
    });
    expect(codeOf(() => assertWilayaCloseConfirmed({ ...input, confirm: true }))).toBeNull();
    expect(codeOf(() => assertWilayaCloseConfirmed({ ...input, wasOpen: false }))).toBeNull();
    expect(codeOf(() => assertWilayaCloseConfirmed({ ...input, isOpen: undefined }))).toBeNull();
  });

  it('matches commune names like the database collation', () => {
    expect(communeKey(16, 'Bab El Oued')).toBe(communeKey(16, 'bab el oued '));
    expect(communeKey(16, 'Bologhine')).toBe(communeKey(16, 'Bologhïne'));
    expect(communeKey(16, 'Hydra')).not.toBe(communeKey(31, 'Hydra'));
  });
});

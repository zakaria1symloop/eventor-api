import type { FormSchema } from './entities/form-version.entity.js';
import { changedKeys, validateAnswers, type AnswerContext } from './form-answers.js';

const ctx = (overrides: Partial<AnswerContext> = {}): AnswerContext => ({
  today: '2026-09-16',
  wilayaCodes: new Set([16, 31]),
  categoryIds: new Set(['cat-1', 'cat-2']),
  files: {},
  maxUploadMb: 5,
  ...overrides,
});

const schema: FormSchema = {
  fields: [
    { key: 'intro', type: 'info', label_en: 'Hello', label_ar: 'مرحبا' },
    { key: 'name', type: 'short_text', label_en: 'Name', label_ar: 'الاسم', required: true, validation: { minLength: 3, maxLength: 20 } },
    { key: 'phone', type: 'phone', label_en: 'Phone', label_ar: 'الهاتف', required: true },
    { key: 'kind', type: 'dropdown', label_en: 'Kind', label_ar: 'النوع', required: true, options: [{ value: 'conference', label_en: 'Conference', label_ar: 'مؤتمر' }, { value: 'other', label_en: 'Other', label_ar: 'أخرى' }] },
    { key: 'other_kind', type: 'short_text', label_en: 'Which?', label_ar: 'ما هو؟', required: true, showIf: { field: 'kind', equals: 'other' } },
    { key: 'other_detail', type: 'long_text', label_en: 'Detail', label_ar: 'تفاصيل', required: true, showIf: { field: 'other_kind', notEmpty: true } },
    { key: 'date', type: 'date', label_en: 'Date', label_ar: 'التاريخ', required: true, validation: { minOffsetDays: 7, maxOffsetDays: 365 } },
    { key: 'slot', type: 'time_range', label_en: 'Slot', label_ar: 'الوقت' },
    { key: 'wilaya', type: 'wilaya', label_en: 'Wilaya', label_ar: 'الولاية', required: true },
    { key: 'people', type: 'number', label_en: 'People', label_ar: 'الحضور', validation: { min: 1, max: 500, integer: true } },
    { key: 'topics', type: 'multi_choice', label_en: 'Topics', label_ar: 'المواضيع', options: [{ value: 'ai', label_en: 'AI', label_ar: 'ذكاء' }, { value: 'bio', label_en: 'Bio', label_ar: 'أحياء' }], validation: { maxSelected: 1 } },
    { key: 'needs', type: 'service_categories', label_en: 'Needs', label_ar: 'الاحتياجات' },
    { key: 'budget', type: 'budget_range', label_en: 'Budget', label_ar: 'الميزانية' },
    { key: 'program', type: 'file', label_en: 'Program', label_ar: 'البرنامج', validation: { maxFiles: 1, types: ['pdf'] } },
    { key: 'contact_email', type: 'email', label_en: 'Email', label_ar: 'البريد' },
    { key: 'terms', type: 'consent', label_en: 'I agree', label_ar: 'أوافق', required: true },
  ],
};

const valid = {
  name: 'Nadia Hamdi',
  phone: '0555 12 34 56',
  kind: 'conference',
  date: '2026-11-10',
  slot: { start: '09:00', end: '17:00' },
  wilaya: 16,
  people: 300,
  topics: ['ai'],
  needs: ['cat-1'],
  budget: { min: 100000, max: 300000 },
  contact_email: 'Nadia@Univ-Alger.dz',
  terms: true,
};

describe('validateAnswers', () => {
  it('accepts valid answers and normalises them', () => {
    const pdf = { fileId: 'f1', mimeType: 'application/pdf', sizeBytes: 2048, originalName: 'program.pdf' };
    const result = validateAnswers(schema, valid, ctx({ files: { program: [pdf] } }));
    expect(result.errors).toEqual([]);
    expect(result.answers).toMatchObject({ phone: '0555123456', contact_email: 'nadia@univ-alger.dz', program: ['f1'] });
    expect(result.answers).not.toHaveProperty('other_kind');
  });

  it('reports required fields and unknown keys', () => {
    const result = validateAnswers(schema, { extra: 1 }, ctx());
    expect(result.errors.map((e) => `${e.fieldKey}:${e.code}`)).toEqual(['extra:UNKNOWN_FIELD', 'name:REQUIRED', 'phone:REQUIRED', 'kind:REQUIRED', 'date:REQUIRED', 'wilaya:REQUIRED', 'terms:CONSENT_REQUIRED']);
    expect(validateAnswers(schema, [], ctx()).errors).toEqual([{ fieldKey: '*', code: 'ANSWERS_NOT_OBJECT' }]);
  });

  it('applies showIf in cascade: shown fields become required, hidden answers are dropped', () => {
    const shown = validateAnswers(schema, { ...valid, kind: 'other' }, ctx());
    expect(shown.errors).toEqual([{ fieldKey: 'other_kind', code: 'REQUIRED' }]);
    const cascade = validateAnswers(schema, { ...valid, kind: 'other', other_kind: 'Workshop' }, ctx());
    expect(cascade.errors).toEqual([{ fieldKey: 'other_detail', code: 'REQUIRED' }]);
    const hidden = validateAnswers(schema, { ...valid, other_kind: 'Ignored', other_detail: 'x' }, ctx());
    expect(hidden.errors).toEqual([]);
    expect(hidden.answers).not.toHaveProperty('other_kind');
    expect(hidden.answers).not.toHaveProperty('other_detail');
  });

  it('checks each type format and constraint', () => {
    const result = validateAnswers(
      schema,
      {
        ...valid,
        name: 'Al',
        phone: '12345',
        kind: 'party',
        date: '2026-09-18',
        slot: { start: '18:00', end: '09:00' },
        wilaya: 99,
        people: 2.5,
        topics: ['ai', 'bio'],
        needs: ['nope'],
        budget: { min: 5, max: 1 },
        contact_email: 'not-an-email',
        terms: false,
      },
      ctx(),
    );
    expect(result.errors.map((e) => `${e.fieldKey}:${e.code}`)).toEqual([
      'name:TOO_SHORT',
      'phone:PHONE_INVALID',
      'kind:OPTION_INVALID',
      'date:DATE_TOO_EARLY',
      'slot:TIME_RANGE_INVALID',
      'wilaya:WILAYA_INVALID',
      'people:NOT_INTEGER',
      'topics:TOO_MANY',
      'needs:CATEGORY_INVALID',
      'budget:BUDGET_INVALID',
      'contact_email:EMAIL_INVALID',
      'terms:CONSENT_REQUIRED',
    ]);
    expect(validateAnswers(schema, { ...valid, date: '2028-01-01' }, ctx()).errors).toEqual([{ fieldKey: 'date', code: 'DATE_TOO_LATE' }]);
    expect(validateAnswers(schema, { ...valid, date: '2026-02-30' }, ctx()).errors).toEqual([{ fieldKey: 'date', code: 'DATE_INVALID' }]);
    expect(validateAnswers(schema, { ...valid, people: 900 }, ctx()).errors).toEqual([{ fieldKey: 'people', code: 'ABOVE_MAX' }]);
    expect(validateAnswers(schema, { ...valid, name: 'x'.repeat(21) }, ctx()).errors).toEqual([{ fieldKey: 'name', code: 'TOO_LONG' }]);
  });

  it('checks file constraints', () => {
    const png = { fileId: 'f2', mimeType: 'image/png', sizeBytes: 10, originalName: 'a.png' };
    const big = { fileId: 'f3', mimeType: 'application/pdf', sizeBytes: 6 * 1024 * 1024, originalName: 'b.pdf' };
    const errors = validateAnswers(schema, valid, ctx({ files: { program: [png, big] } })).errors.map((e) => e.code);
    expect(errors).toEqual(['TOO_MANY_FILES', 'FILE_TYPE_NOT_ALLOWED', 'FILE_TOO_LARGE']);
    expect(validateAnswers(schema, valid, ctx({ files: { photo: [png] } })).errors).toEqual([{ fieldKey: 'photo', code: 'UNKNOWN_FIELD' }]);
  });
});

describe('changedKeys', () => {
  it('lists added, removed and changed keys', () => {
    expect(changedKeys({ a: 1, b: [1], c: 'x', r: { min: 1, max: 2 } }, { a: 1, b: [2], d: true, r: { max: 2, min: 1 } })).toEqual(['b', 'c', 'd']);
  });
});

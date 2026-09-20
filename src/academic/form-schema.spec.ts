import type { FormSchema } from './entities/form-version.entity.js';
import { missingTranslations, starterSchema, validateFormSchema } from './form-schema.js';

const codes = (schema: unknown, publish = false) => validateFormSchema(schema, { publish }).map((i) => `${i.path}:${i.code}`);

describe('validateFormSchema', () => {
  it('accepts the starter schema for draft and publish, with complete translations', () => {
    expect(validateFormSchema(starterSchema(), { publish: true })).toEqual([]);
    expect(missingTranslations(starterSchema())).toEqual([]);
  });

  it('rejects a non-object schema and a missing fields array', () => {
    expect(codes(null)).toEqual(['schema:SCHEMA_NOT_OBJECT']);
    expect(codes({ fields: 'x', extra: 1 })).toEqual(['extra:UNKNOWN_PROPERTY', 'fields:FIELDS_NOT_ARRAY']);
  });

  it('checks keys, types, labels and unknown properties', () => {
    const result = codes({
      fields: [
        { key: 'Title', type: 'short_text', label_en: 'T', label_ar: 'ع' },
        { key: 'a', type: 'nope', label_en: 'A', label_ar: 'أ', color: 'red' },
        { key: 'a', type: 'number', label_en: 1, label_ar: 'أ' },
        { key: 'b', type: 'info', label_en: 'B', label_ar: 'ب', required: true },
      ],
    });
    expect(result).toEqual(
      expect.arrayContaining([
        'fields[0].key:KEY_INVALID',
        'fields[1].type:TYPE_INVALID',
        'fields[1].color:UNKNOWN_PROPERTY',
        'fields[2].key:KEY_DUPLICATE',
        'fields[2].label_en:LABEL_INVALID',
        'fields[3].required:REQUIRED_NOT_ALLOWED',
      ]),
    );
  });

  it('requires options with EN and AR labels on choice fields only, values unique', () => {
    const result = codes({
      fields: [
        { key: 'c', type: 'dropdown', label_en: 'C', label_ar: 'ج' },
        { key: 'd', type: 'single_choice', label_en: 'D', label_ar: 'د', options: [{ value: 'x', label_en: 'X' }, { value: 'x', label_en: 'X', label_ar: 'س' }] },
        { key: 'e', type: 'short_text', label_en: 'E', label_ar: 'ه', options: [] },
      ],
    });
    expect(result).toEqual(['fields[0].options:OPTIONS_REQUIRED', 'fields[1].options[0].label_ar:OPTION_LABEL_MISSING', 'fields[1].options[1].value:OPTION_VALUE_DUPLICATE', 'fields[2].options:OPTIONS_NOT_ALLOWED']);
  });

  it('validates validation objects per type', () => {
    const result = codes({
      fields: [
        { key: 'a', type: 'short_text', label_en: 'A', label_ar: 'أ', validation: { minLength: 10, maxLength: 5, pattern: '(' } },
        { key: 'b', type: 'email', label_en: 'B', label_ar: 'ب', validation: { maxLength: 3 } },
        { key: 'c', type: 'number', label_en: 'C', label_ar: 'ج', validation: { integer: 'yes', step: 1 } },
        { key: 'd', type: 'file', label_en: 'D', label_ar: 'د', validation: { maxFiles: 11, types: ['exe'] } },
        { key: 'e', type: 'date', label_en: 'E', label_ar: 'ه', validation: { minOffsetDays: -3, maxOffsetDays: 30 } },
      ],
    });
    expect(result).toEqual([
      'fields[0].validation.pattern:PATTERN_INVALID',
      'fields[0].validation:VALIDATION_RANGE_INVALID',
      'fields[1].validation:VALIDATION_NOT_ALLOWED',
      'fields[2].validation.integer:VALIDATION_INVALID',
      'fields[2].validation.step:UNKNOWN_PROPERTY',
      'fields[3].validation.types:VALIDATION_INVALID',
      'fields[3].validation.maxFiles:VALIDATION_INVALID',
    ]);
  });

  it('showIf must reference an earlier answerable field with exactly one operator', () => {
    const result = codes({
      fields: [
        { key: 'later', type: 'short_text', label_en: 'L', label_ar: 'ل', showIf: { field: 'kind', equals: 'x' } },
        { key: 'kind', type: 'dropdown', label_en: 'K', label_ar: 'ك', options: [{ value: 'x', label_en: 'X', label_ar: 'س' }] },
        { key: 'both', type: 'short_text', label_en: 'B', label_ar: 'ب', showIf: { field: 'kind', equals: 'x', notEmpty: true } },
        { key: 'ok', type: 'short_text', label_en: 'O', label_ar: 'و', showIf: { field: 'kind', in: ['x'] } },
      ],
    });
    expect(result).toEqual(['fields[0].showIf.field:SHOW_IF_FIELD_UNKNOWN', 'fields[2].showIf:SHOW_IF_INVALID']);
  });

  it('checks mappings: known, once, compatible type, event type values', () => {
    const result = codes({
      fields: [
        { key: 'a', type: 'short_text', label_en: 'A', label_ar: 'أ', maps_to: 'title' },
        { key: 'b', type: 'short_text', label_en: 'B', label_ar: 'ب', maps_to: 'title' },
        { key: 'c', type: 'number', label_en: 'C', label_ar: 'ج', maps_to: 'event_date' },
        { key: 'd', type: 'short_text', label_en: 'D', label_ar: 'د', maps_to: 'color' },
        { key: 'e', type: 'dropdown', label_en: 'E', label_ar: 'ه', maps_to: 'event_type', options: [{ value: 'party', label_en: 'P', label_ar: 'ح' }] },
      ],
    });
    expect(result).toEqual(['fields[1].maps_to:MAPPING_DUPLICATE', 'fields[2].maps_to:MAPPING_TYPE_MISMATCH', 'fields[3].maps_to:MAPPING_INVALID', 'fields[4].options:MAPPING_OPTIONS_INVALID']);
  });

  it('requires the system mappings to publish only', () => {
    const schema = { fields: [{ key: 'a', type: 'short_text', label_en: 'A', label_ar: 'أ', maps_to: 'title' }] };
    expect(codes(schema)).toEqual([]);
    expect(codes(schema, true)).toEqual([
      'fields.maps_to.event_date:MAPPING_REQUIRED',
      'fields.maps_to.wilaya:MAPPING_REQUIRED',
      'fields.maps_to.requester_name:MAPPING_REQUIRED',
      'fields.maps_to.requester_phone:MAPPING_REQUIRED',
    ]);
  });

  it('lists labels missing a translation', () => {
    const schema: FormSchema = { fields: [{ key: 'a', type: 'dropdown', label_en: 'A', label_ar: ' ', options: [{ value: 'x', label_en: '', label_ar: 'س' }] }] };
    expect(missingTranslations(schema)).toEqual([
      { path: 'fields[0].label_ar', code: 'TRANSLATION_MISSING' },
      { path: 'fields[0].options[0].label_en', code: 'TRANSLATION_MISSING' },
    ]);
  });
});

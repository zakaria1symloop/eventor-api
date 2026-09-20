import { EventType } from '../common/enums/catalog.enums.js';
import type { FormField, FormFieldType, FormMappableField, FormSchema } from './entities/form-version.entity.js';

/**
 * Form schema rules (db-schema §7, ACR-06). Pure functions shared by the builder
 * (draft save, publish) and the answer validator.
 */

export const FIELD_TYPES: readonly FormFieldType[] = [
  'short_text',
  'long_text',
  'number',
  'email',
  'phone',
  'single_choice',
  'multi_choice',
  'dropdown',
  'date',
  'time_range',
  'wilaya',
  'service_categories',
  'budget_range',
  'file',
  'section',
  'info',
  'consent',
];

export const MAPPABLE_FIELDS: readonly FormMappableField[] = [
  'title',
  'event_type',
  'event_date',
  'wilaya',
  'attendees',
  'institution_name',
  'needs',
  'budget',
  'requester_name',
  'requester_phone',
];

/** Mappings a form needs before it can be published. */
export const REQUIRED_MAPPINGS: readonly FormMappableField[] = ['title', 'event_date', 'wilaya', 'requester_name', 'requester_phone'];

export const MAPPING_TYPES: Record<FormMappableField, FormFieldType[]> = {
  title: ['short_text'],
  institution_name: ['short_text'],
  event_type: ['single_choice', 'dropdown'],
  event_date: ['date'],
  wilaya: ['wilaya'],
  attendees: ['number'],
  needs: ['service_categories'],
  budget: ['budget_range'],
  requester_name: ['short_text'],
  requester_phone: ['phone'],
};

export const CHOICE_TYPES: readonly FormFieldType[] = ['single_choice', 'multi_choice', 'dropdown'];
/** Layout-only fields: no answer, no required flag, no mapping. */
export const DISPLAY_TYPES: readonly FormFieldType[] = ['section', 'info'];
export const FILE_EXTENSIONS = ['pdf', 'jpg', 'png'] as const;
export const FILE_MIME: Record<(typeof FILE_EXTENSIONS)[number], string> = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };
export const MAX_FIELDS = 200;

const VALIDATION_KEYS: Partial<Record<FormFieldType, Record<string, 'int' | 'number' | 'bool' | 'pattern' | 'types'>>> = {
  short_text: { minLength: 'int', maxLength: 'int', pattern: 'pattern' },
  long_text: { minLength: 'int', maxLength: 'int', pattern: 'pattern' },
  number: { min: 'number', max: 'number', integer: 'bool' },
  multi_choice: { minSelected: 'int', maxSelected: 'int' },
  service_categories: { minSelected: 'int', maxSelected: 'int' },
  date: { minOffsetDays: 'int', maxOffsetDays: 'int' },
  budget_range: { min: 'number', max: 'number' },
  file: { maxFiles: 'int', types: 'types', maxSizeMb: 'number' },
};

const RANGES: [string, string][] = [
  ['minLength', 'maxLength'],
  ['min', 'max'],
  ['minSelected', 'maxSelected'],
  ['minOffsetDays', 'maxOffsetDays'],
];

const FIELD_PROPS = new Set(['key', 'type', 'label_en', 'label_ar', 'help_en', 'help_ar', 'required', 'options', 'validation', 'showIf', 'section', 'maps_to']);
const KEY = /^[a-z][a-z0-9_]{0,59}$/;

export interface SchemaIssue {
  path: string;
  code: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural validation (draft save). Labels must be strings but may be empty.
 * With `publish`, required mappings are checked too.
 */
export function validateFormSchema(schema: unknown, options: { publish?: boolean } = {}): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const add = (path: string, code: string) => issues.push({ path, code });
  if (!isObject(schema)) return [{ path: 'schema', code: 'SCHEMA_NOT_OBJECT' }];
  for (const prop of Object.keys(schema)) if (prop !== 'fields') add(prop, 'UNKNOWN_PROPERTY');
  const fields = schema.fields;
  if (!Array.isArray(fields)) return [...issues, { path: 'fields', code: 'FIELDS_NOT_ARRAY' }];
  if (fields.length > MAX_FIELDS) add('fields', 'TOO_MANY_FIELDS');

  const seen = new Map<string, FormFieldType | undefined>();
  const mapped = new Set<string>();
  const sections = new Set(fields.filter((f) => isObject(f) && f.type === 'section' && typeof f.key === 'string').map((f) => (f as { key: string }).key));

  fields.forEach((raw, i) => {
    const p = `fields[${i}]`;
    if (!isObject(raw)) return add(p, 'FIELD_NOT_OBJECT');
    for (const prop of Object.keys(raw)) if (!FIELD_PROPS.has(prop)) add(`${p}.${prop}`, 'UNKNOWN_PROPERTY');
    const type = raw.type as FormFieldType;
    const typeOk = FIELD_TYPES.includes(type);
    if (!typeOk) add(`${p}.type`, 'TYPE_INVALID');

    if (typeof raw.key !== 'string' || !KEY.test(raw.key)) add(`${p}.key`, 'KEY_INVALID');
    else if (seen.has(raw.key)) add(`${p}.key`, 'KEY_DUPLICATE');

    for (const lang of ['label_en', 'label_ar'] as const) {
      if (typeof raw[lang] !== 'string' || (raw[lang] as string).length > 500) add(`${p}.${lang}`, 'LABEL_INVALID');
    }
    for (const lang of ['help_en', 'help_ar'] as const) {
      if (raw[lang] !== undefined && raw[lang] !== null && (typeof raw[lang] !== 'string' || (raw[lang] as string).length > 2000)) add(`${p}.${lang}`, 'HELP_INVALID');
    }
    if (raw.required !== undefined) {
      if (typeof raw.required !== 'boolean') add(`${p}.required`, 'REQUIRED_INVALID');
      else if (raw.required && DISPLAY_TYPES.includes(type)) add(`${p}.required`, 'REQUIRED_NOT_ALLOWED');
    }

    // options
    if (typeOk && CHOICE_TYPES.includes(type)) {
      if (!Array.isArray(raw.options) || raw.options.length === 0) add(`${p}.options`, 'OPTIONS_REQUIRED');
      else {
        const values = new Set<string>();
        raw.options.forEach((option, j) => {
          const op = `${p}.options[${j}]`;
          if (!isObject(option)) return add(op, 'OPTION_INVALID');
          for (const prop of Object.keys(option)) if (!['value', 'label_en', 'label_ar'].includes(prop)) add(`${op}.${prop}`, 'UNKNOWN_PROPERTY');
          if (typeof option.value !== 'string' || option.value.length === 0 || option.value.length > 60) add(`${op}.value`, 'OPTION_VALUE_INVALID');
          else if (values.has(option.value)) add(`${op}.value`, 'OPTION_VALUE_DUPLICATE');
          else values.add(option.value);
          for (const lang of ['label_en', 'label_ar'] as const) if (typeof option[lang] !== 'string') add(`${op}.${lang}`, 'OPTION_LABEL_MISSING');
        });
      }
    } else if (raw.options !== undefined) add(`${p}.options`, 'OPTIONS_NOT_ALLOWED');

    // validation
    if (raw.validation !== undefined && raw.validation !== null) {
      const allowed = typeOk ? VALIDATION_KEYS[type] : undefined;
      if (!isObject(raw.validation)) add(`${p}.validation`, 'VALIDATION_INVALID');
      else if (!allowed) {
        if (Object.keys(raw.validation).length > 0) add(`${p}.validation`, 'VALIDATION_NOT_ALLOWED');
      } else {
        const v = raw.validation;
        for (const [name, value] of Object.entries(v)) {
          const kind = allowed[name];
          const vp = `${p}.validation.${name}`;
          if (!kind) add(vp, 'UNKNOWN_PROPERTY');
          else if (kind === 'int' && !(Number.isInteger(value) && (name.endsWith('OffsetDays') || (value as number) >= 0))) add(vp, 'VALIDATION_INVALID');
          else if (kind === 'number' && !(typeof value === 'number' && Number.isFinite(value))) add(vp, 'VALIDATION_INVALID');
          else if (kind === 'bool' && typeof value !== 'boolean') add(vp, 'VALIDATION_INVALID');
          else if (kind === 'pattern') {
            if (typeof value !== 'string' || value.length > 200 || !isRegex(value)) add(vp, 'PATTERN_INVALID');
          } else if (kind === 'types' && !(Array.isArray(value) && value.length > 0 && value.every((t) => (FILE_EXTENSIONS as readonly string[]).includes(t as string)))) add(vp, 'VALIDATION_INVALID');
        }
        if (type === 'file') {
          if (v.maxFiles !== undefined && Number.isInteger(v.maxFiles) && ((v.maxFiles as number) < 1 || (v.maxFiles as number) > 10)) add(`${p}.validation.maxFiles`, 'VALIDATION_INVALID');
          if (typeof v.maxSizeMb === 'number' && v.maxSizeMb <= 0) add(`${p}.validation.maxSizeMb`, 'VALIDATION_INVALID');
        }
        for (const [min, max] of RANGES) {
          if (typeof v[min] === 'number' && typeof v[max] === 'number' && (v[min] as number) > (v[max] as number)) add(`${p}.validation`, 'VALIDATION_RANGE_INVALID');
        }
      }
    }

    // showIf
    if (raw.showIf !== undefined && raw.showIf !== null) {
      const s = raw.showIf;
      if (!isObject(s)) add(`${p}.showIf`, 'SHOW_IF_INVALID');
      else {
        const operators = ['equals', 'in', 'notEmpty'].filter((op) => s[op] !== undefined);
        const unknown = Object.keys(s).filter((k) => !['field', 'equals', 'in', 'notEmpty'].includes(k));
        const valid =
          unknown.length === 0 &&
          operators.length === 1 &&
          (s.equals === undefined || ['string', 'number', 'boolean'].includes(typeof s.equals)) &&
          (s.in === undefined || (Array.isArray(s.in) && s.in.length > 0 && s.in.every((x) => typeof x === 'string'))) &&
          (s.notEmpty === undefined || s.notEmpty === true);
        if (!valid) add(`${p}.showIf`, 'SHOW_IF_INVALID');
        const target = typeof s.field === 'string' ? seen.get(s.field) : undefined;
        if (typeof s.field !== 'string' || !seen.has(s.field) || (target && ['section', 'info', 'file'].includes(target))) add(`${p}.showIf.field`, 'SHOW_IF_FIELD_UNKNOWN');
      }
    }

    // section
    if (raw.section !== undefined && raw.section !== null) {
      if (typeof raw.section !== 'string' || !sections.has(raw.section) || type === 'section') add(`${p}.section`, 'SECTION_INVALID');
    }

    // mapping
    if (raw.maps_to !== undefined && raw.maps_to !== null) {
      const target = raw.maps_to as FormMappableField;
      if (!MAPPABLE_FIELDS.includes(target)) add(`${p}.maps_to`, 'MAPPING_INVALID');
      else if (mapped.has(target)) add(`${p}.maps_to`, 'MAPPING_DUPLICATE');
      else {
        mapped.add(target);
        if (typeOk && !MAPPING_TYPES[target].includes(type)) add(`${p}.maps_to`, 'MAPPING_TYPE_MISMATCH');
        else if (target === 'event_type' && Array.isArray(raw.options)) {
          const values = Object.values(EventType) as string[];
          if (raw.options.some((o) => isObject(o) && typeof o.value === 'string' && !values.includes(o.value))) add(`${p}.options`, 'MAPPING_OPTIONS_INVALID');
        }
      }
    }

    if (typeof raw.key === 'string' && KEY.test(raw.key) && !seen.has(raw.key)) seen.set(raw.key, typeOk ? type : undefined);
  });

  if (options.publish) {
    const missing = REQUIRED_MAPPINGS.filter((m) => !mapped.has(m));
    for (const m of missing) add(`fields.maps_to.${m}`, 'MAPPING_REQUIRED');
    if (fields.filter((f) => isObject(f) && !DISPLAY_TYPES.includes(f.type as FormFieldType)).length === 0) add('fields', 'NO_INPUT_FIELDS');
  }
  return issues;
}

/** Every EN and AR label (field and option) must be non-empty to publish. */
export function missingTranslations(schema: FormSchema): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  schema.fields.forEach((field, i) => {
    for (const lang of ['label_en', 'label_ar'] as const) if (!field[lang]?.trim()) issues.push({ path: `fields[${i}].${lang}`, code: 'TRANSLATION_MISSING' });
    field.options?.forEach((option, j) => {
      for (const lang of ['label_en', 'label_ar'] as const) if (!option[lang]?.trim()) issues.push({ path: `fields[${i}].options[${j}].${lang}`, code: 'TRANSLATION_MISSING' });
    });
  });
  return issues;
}

function isRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

export const fieldByKey = (schema: FormSchema, key: string): FormField | undefined => schema.fields.find((f) => f.key === key);
export const mappedField = (schema: FormSchema, target: FormMappableField): FormField | undefined => schema.fields.find((f) => f.maps_to === target);

/** The schema of a new form: every system-mapped field, labels in both languages. */
export function starterSchema(): FormSchema {
  return {
    fields: [
      { key: 'requester', type: 'section', label_en: 'About you', label_ar: 'معلوماتك' },
      { key: 'full_name', type: 'short_text', label_en: 'Full name', label_ar: 'الاسم الكامل', required: true, maps_to: 'requester_name', section: 'requester', validation: { maxLength: 120 } },
      { key: 'phone', type: 'phone', label_en: 'Phone', label_ar: 'الهاتف', required: true, maps_to: 'requester_phone', section: 'requester' },
      { key: 'institution', type: 'short_text', label_en: 'Institution', label_ar: 'المؤسسة', required: true, maps_to: 'institution_name', section: 'requester', validation: { maxLength: 190 } },
      { key: 'event', type: 'section', label_en: 'Your event', label_ar: 'مناسبتك' },
      { key: 'title', type: 'short_text', label_en: 'Event title', label_ar: 'عنوان المناسبة', required: true, maps_to: 'title', section: 'event', validation: { maxLength: 190 } },
      {
        key: 'event_type',
        type: 'dropdown',
        label_en: 'Event type',
        label_ar: 'نوع المناسبة',
        required: true,
        maps_to: 'event_type',
        section: 'event',
        options: [
          { value: 'conference', label_en: 'Conference', label_ar: 'مؤتمر' },
          { value: 'academic', label_en: 'Scientific day', label_ar: 'يوم علمي' },
          { value: 'graduation', label_en: 'Graduation', label_ar: 'حفل تخرج' },
          { value: 'other', label_en: 'Other', label_ar: 'أخرى' },
        ],
      },
      { key: 'event_date', type: 'date', label_en: 'Event date', label_ar: 'تاريخ المناسبة', required: true, maps_to: 'event_date', section: 'event', validation: { minOffsetDays: 7 } },
      { key: 'wilaya', type: 'wilaya', label_en: 'Wilaya', label_ar: 'الولاية', required: true, maps_to: 'wilaya', section: 'event' },
      { key: 'attendees', type: 'number', label_en: 'Expected attendees', label_ar: 'عدد الحضور المتوقع', maps_to: 'attendees', section: 'event', validation: { min: 1, max: 100000, integer: true } },
      { key: 'needs', type: 'service_categories', label_en: 'What do you need?', label_ar: 'ما الذي تحتاجه؟', maps_to: 'needs', section: 'event' },
      { key: 'budget', type: 'budget_range', label_en: 'Budget (DZD)', label_ar: 'الميزانية (دج)', maps_to: 'budget', section: 'event', validation: { min: 0 } },
    ],
  };
}

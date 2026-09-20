import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { FormVersion } from '../src/academic/entities/form-version.entity.js';
import { Form } from '../src/academic/entities/form.entity.js';
import { starterSchema } from '../src/academic/form-schema.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { createApp, expectError, loginAs, makeAcademicRequest, uid, type LoggedIn, type TestApp } from './utils/index.js';

const BASE = '/api/v1/admin/forms';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin forms (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;
  let client: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
    client = await loginAs(t, UserRole.Client);
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const audited = (action: string, objectId: string) => db().getRepository(AuditLog).findOneBy({ action, objectId });
  const create = (body: Record<string, unknown> = {}) =>
    request(t.http)
      .post(BASE)
      .set(admin.headers)
      .send({ nameEn: `Scientific day ${uid()}`, nameAr: 'يوم علمي', ...body });

  async function published() {
    const form = (await create().expect(201)).body.data;
    await request(t.http).post(`${BASE}/${form.id}/publish`).set(admin.headers).expect(200);
    return form;
  }

  describe('POST /admin/forms', () => {
    it('creates a draft with the starter schema, slug from the name, audit', async () => {
      const name = `Science Day ${uid()}`;
      const res = await create({ nameEn: name, descriptionEn: 'Tell us about your event.' }).expect(201);
      const f = res.body.data;
      expect(f).toMatchObject({
        slug: name.toLowerCase().replace(/ /g, '-'),
        nameEn: name,
        status: 'draft',
        liveVersion: null,
        submissionsCount: 0,
        hasDraftChanges: true,
        versions: [],
        descriptionEn: 'Tell us about your event.',
        descriptionAr: null,
        requiresAuth: false,
        maxSubmissionsPerEmailPerMonth: null,
        publicUrl: expect.stringContaining(`/f/${f.slug}`),
        createdBy: { id: admin.user.id },
      });
      expect(f.draftSchema).toEqual(starterSchema());
      expect(await audited('form.created', f.id)).toBeTruthy();
    });

    it('validates input and refuses a taken slug', async () => {
      const bad = await request(t.http).post(BASE).set(admin.headers).send({ nameAr: 'x', slug: 'Bad Slug', color: 1 });
      expectError(bad, 400, 'VALIDATION_FAILED');
      expect(bad.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['nameEn', 'slug', 'color']));
      const slug = `taken-${uid()}`;
      await create({ slug }).expect(201);
      const taken = await create({ slug }).set('Accept-Language', 'ar');
      expectError(taken, 409, 'SLUG_TAKEN');
      expect(taken.body.message).toBe('هذا المعرّف مستخدم بالفعل.');
      // Generated slugs get a suffix instead.
      const a = (await create({ nameEn: 'Same Name Form' }).expect(201)).body.data;
      const b = (await create({ nameEn: 'Same Name Form' }).expect(201)).body.data;
      expect(b.slug).not.toBe(a.slug);
    });

    it('401 without a token, 403 for a client', async () => {
      expectError(await request(t.http).post(BASE).send({}), 401, 'AUTH_TOKEN_MISSING');
      expectError(await request(t.http).get(BASE).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('GET /admin/forms', () => {
    it('lists with tabs counts, search, sort and pagination', async () => {
      const tag = uid();
      const draft = (await create({ nameEn: `Zeta ${tag}` }).expect(201)).body.data;
      const live = (await create({ nameEn: `Alpha ${tag}` }).expect(201)).body.data;
      await request(t.http).post(`${BASE}/${live.id}/publish`).set(admin.headers).expect(200);
      const closed = (await create({ nameEn: `Mid ${tag}` }).expect(201)).body.data;
      await request(t.http).post(`${BASE}/${closed.id}/publish`).set(admin.headers).expect(200);
      await request(t.http).post(`${BASE}/${closed.id}/close`).set(admin.headers).expect(200);

      const res = await request(t.http).get(BASE).set(admin.headers).query({ q: tag, sort: 'nameEn:asc' }).expect(200);
      expect(res.body.meta).toMatchObject({ page: 1, total: 3, counts: { all: 3, draft: 1, published: 1, closed: 1 } });
      expect(res.body.data.map((r: any) => r.id)).toEqual([live.id, closed.id, draft.id]);
      expect(res.body.data[0]).toMatchObject({ liveVersion: { version: 1 }, hasDraftChanges: false, status: 'published' });
      const tab = await request(t.http).get(BASE).set(admin.headers).query({ q: tag, tab: 'closed' }).expect(200);
      expect(tab.body.data.map((r: any) => r.id)).toEqual([closed.id]);
      expect(tab.body.meta.counts.all).toBe(3);
      const page = await request(t.http).get(BASE).set(admin.headers).query({ q: tag, limit: 1, page: 2, sort: 'nameEn:asc' }).expect(200);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 1, totalPages: 3 });
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ sort: 'slug:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ tab: 'archived' }), 400, 'VALIDATION_FAILED');
    });

    it('registers the forms and academic-requests exports', () => {
      const registry = t.get(ExportRegistry);
      expect(registry.get('forms')).toBeTruthy();
      expect(registry.get('academic-requests')).toBeTruthy();
    });
  });

  describe('GET /admin/forms/:id', () => {
    it('404 for unknown and malformed ids', async () => {
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'FORM_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/nope`).set(admin.headers), 404, 'FORM_NOT_FOUND');
    });
  });

  describe('PATCH /admin/forms/:id', () => {
    it('updates settings, keeps exactly one default, optimistic concurrency', async () => {
      const a = (await create().expect(201)).body.data;
      const b = (await create().expect(201)).body.data;
      const res = await request(t.http)
        .patch(`${BASE}/${a.id}`)
        .set(admin.headers)
        .send({ isDefault: true, requiresAuth: true, maxSubmissionsPerEmailPerMonth: 3, confirmationAr: 'شكرًا لكم', updatedAt: a.updatedAt })
        .expect(200);
      expect(res.body.data).toMatchObject({ isDefault: true, requiresAuth: true, maxSubmissionsPerEmailPerMonth: 3, confirmationAr: 'شكرًا لكم' });
      expect((await db().getRepository(Form).countBy({ isDefault: true }))).toBe(1);
      expect(await audited('form.updated', a.id)).toMatchObject({ changes: expect.objectContaining({ isDefault: { from: false, to: true } }) });

      expectError(await request(t.http).patch(`${BASE}/${a.id}`).set(admin.headers).send({ isDefault: false }), 409, 'FORM_DEFAULT_REQUIRED');
      expectError(await request(t.http).patch(`${BASE}/${a.id}`).set(admin.headers).send({ nameEn: 'Old', updatedAt: a.updatedAt }), 409, 'STALE_UPDATE');
      expectError(await request(t.http).patch(`${BASE}/${b.id}`).set(admin.headers).send({ slug: a.slug }), 409, 'SLUG_TAKEN');
      expectError(await request(t.http).patch(`${BASE}/${b.id}`).set(admin.headers).send({ maxSubmissionsPerEmailPerMonth: 0 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(admin.headers).send({ nameEn: 'Xx' }), 404, 'FORM_NOT_FOUND');
    });
  });

  describe('PUT /admin/forms/:id/draft', () => {
    it('saves a valid draft (empty labels allowed) without touching the live version', async () => {
      const form = await published();
      const schema = starterSchema();
      schema.fields.push({ key: 'programme', type: 'file', label_en: 'Programme', label_ar: '', validation: { maxFiles: 2, types: ['pdf'] } });
      const res = await request(t.http).put(`${BASE}/${form.id}/draft`).set(admin.headers).send({ schema }).expect(200);
      expect(res.body.data).toMatchObject({ hasDraftChanges: true, liveVersion: { version: 1 } });
      expect(res.body.data.draftSchema.fields.at(-1).key).toBe('programme');
      expect(await audited('form.draft_saved', form.id)).toBeTruthy();
    });

    it('rejects invalid schemas with paths and codes', async () => {
      const form = (await create().expect(201)).body.data;
      const put = (schema: unknown) => request(t.http).put(`${BASE}/${form.id}/draft`).set(admin.headers).send({ schema });
      const cases: [unknown, { path: string; code: string }][] = [
        [{ fields: [{ key: 'a', type: 'color', label_en: 'A', label_ar: 'أ' }] }, { path: 'fields[0].type', code: 'TYPE_INVALID' }],
        [{ fields: [{ key: 'a', type: 'short_text', label_en: 'A', label_ar: 'أ' }, { key: 'a', type: 'number', label_en: 'B', label_ar: 'ب' }] }, { path: 'fields[1].key', code: 'KEY_DUPLICATE' }],
        [
          { fields: [{ key: 'a', type: 'short_text', label_en: 'A', label_ar: 'أ', maps_to: 'title' }, { key: 'b', type: 'short_text', label_en: 'B', label_ar: 'ب', maps_to: 'title' }] },
          { path: 'fields[1].maps_to', code: 'MAPPING_DUPLICATE' },
        ],
        [{ fields: [{ key: 'a', type: 'dropdown', label_en: 'A', label_ar: 'أ', options: [{ value: 'x', label_en: 'X' }] }] }, { path: 'fields[0].options[0].label_ar', code: 'OPTION_LABEL_MISSING' }],
        [{ fields: [{ key: 'a', type: 'short_text', label_en: 'A', label_ar: 'أ', showIf: { field: 'b', equals: 'x' } }, { key: 'b', type: 'short_text', label_en: 'B', label_ar: 'ب' }] }, { path: 'fields[0].showIf.field', code: 'SHOW_IF_FIELD_UNKNOWN' }],
        [{ fields: [{ key: 'a', type: 'number', label_en: 'A', label_ar: 'أ', validation: { min: 5, max: 1 } }] }, { path: 'fields[0].validation', code: 'VALIDATION_RANGE_INVALID' }],
      ];
      for (const [schema, issue] of cases) {
        const res = await put(schema);
        expectError(res, 422, 'FORM_SCHEMA_INVALID');
        expect(res.body.details).toContainEqual(issue);
      }
      expectError(await request(t.http).put(`${BASE}/${form.id}/draft`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).put(`${BASE}/${MISSING}/draft`).set(admin.headers).send({ schema: starterSchema() }), 404, 'FORM_NOT_FOUND');
    });
  });

  describe('POST /admin/forms/:id/publish', () => {
    it('creates immutable versions; old versions stay readable', async () => {
      const form = (await create().expect(201)).body.data;
      const v1 = await request(t.http).post(`${BASE}/${form.id}/publish`).set(admin.headers).expect(200);
      expect(v1.body.data).toMatchObject({ status: 'published', liveVersion: { version: 1 }, versions: [{ version: 1, publishedBy: { id: admin.user.id } }] });
      const schema = starterSchema();
      schema.fields[5]!.label_en = 'Name of the event';
      await request(t.http).put(`${BASE}/${form.id}/draft`).set(admin.headers).send({ schema }).expect(200);
      const v2 = await request(t.http).post(`${BASE}/${form.id}/publish`).set(admin.headers).expect(200);
      expect(v2.body.data.versions.map((v: any) => v.version)).toEqual([2, 1]);
      const oldId = v2.body.data.versions[1].id;
      const old = await request(t.http).get(`${BASE}/${form.id}/versions/${oldId}`).set(admin.headers).expect(200);
      expect(old.body.data).toMatchObject({ version: 1, formId: form.id, submissionsCount: 0 });
      expect(old.body.data.schema.fields[5].label_en).toBe('Event title');
      expect(await db().getRepository(FormVersion).countBy({ formId: form.id })).toBe(2);
      expect(await audited('form.published', form.id)).toBeTruthy();
      expectError(await request(t.http).get(`${BASE}/${form.id}/versions/${MISSING}`).set(admin.headers), 404, 'FORM_VERSION_NOT_FOUND');
    });

    it('requires system mappings and translations; closed forms cannot publish', async () => {
      const form = (await create().expect(201)).body.data;
      const noDate = starterSchema();
      noDate.fields = noDate.fields.filter((f) => f.maps_to !== 'event_date');
      await request(t.http).put(`${BASE}/${form.id}/draft`).set(admin.headers).send({ schema: noDate }).expect(200);
      const missing = await request(t.http).post(`${BASE}/${form.id}/publish`).set(admin.headers);
      expectError(missing, 422, 'FORM_SCHEMA_INVALID');
      expect(missing.body.details).toEqual([{ path: 'fields.maps_to.event_date', code: 'MAPPING_REQUIRED' }]);

      const untranslated = starterSchema();
      untranslated.fields[1]!.label_ar = '';
      await request(t.http).put(`${BASE}/${form.id}/draft`).set(admin.headers).send({ schema: untranslated }).expect(200);
      const translation = await request(t.http).post(`${BASE}/${form.id}/publish`).set(admin.headers);
      expectError(translation, 422, 'FORM_TRANSLATION_MISSING');
      expect(translation.body.details).toEqual([{ path: 'fields[1].label_ar', code: 'TRANSLATION_MISSING' }]);

      const live = await published();
      await request(t.http).post(`${BASE}/${live.id}/close`).set(admin.headers).expect(200);
      expectError(await request(t.http).post(`${BASE}/${live.id}/publish`).set(admin.headers), 409, 'FORM_INVALID_TRANSITION');
    });
  });

  describe('close / reopen / duplicate / delete', () => {
    it('closes and reopens with transition guards', async () => {
      const draft = (await create().expect(201)).body.data;
      expectError(await request(t.http).post(`${BASE}/${draft.id}/close`).set(admin.headers), 409, 'FORM_INVALID_TRANSITION');
      const form = await published();
      const closed = await request(t.http).post(`${BASE}/${form.id}/close`).set(admin.headers).expect(200);
      expect(closed.body.data.status).toBe('closed');
      expect(await audited('form.closed', form.id)).toBeTruthy();
      expectError(await request(t.http).post(`${BASE}/${form.id}/close`).set(admin.headers), 409, 'FORM_INVALID_TRANSITION');
      const reopened = await request(t.http).post(`${BASE}/${form.id}/reopen`).set(admin.headers).expect(200);
      expect(reopened.body.data.status).toBe('published');
      expectError(await request(t.http).post(`${BASE}/${form.id}/reopen`).set(admin.headers), 409, 'FORM_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/reopen`).set(admin.headers), 404, 'FORM_NOT_FOUND');
    });

    it('duplicates as a non-default draft with a copy slug', async () => {
      const form = await published();
      const res = await request(t.http).post(`${BASE}/${form.id}/duplicate`).set(admin.headers).expect(201);
      expect(res.body.data).toMatchObject({ slug: `${form.slug}-copy`, nameEn: `${form.nameEn} (copy)`, status: 'draft', isDefault: false, liveVersion: null });
      expect(res.body.data.draftSchema).toEqual(starterSchema());
      const again = await request(t.http).post(`${BASE}/${form.id}/duplicate`).set(admin.headers).expect(201);
      expect(again.body.data.slug).toBe(`${form.slug}-copy-2`);
      expect(await audited('form.duplicated', res.body.data.id)).toBeTruthy();
    });

    it('deletes only without submissions and never the default; the slug is freed', async () => {
      const form = await published();
      const withRequest = await published();
      const [version] = await db().query('SELECT id FROM form_versions WHERE form_id = ?', [withRequest.id]);
      await makeAcademicRequest(db(), { formId: withRequest.id, formVersionId: version.id });
      const refused = await request(t.http).delete(`${BASE}/${withRequest.id}`).set(admin.headers);
      expectError(refused, 409, 'FORM_HAS_SUBMISSIONS');
      expect(refused.body.details).toEqual({ submissionsCount: 1 });

      const [defaultForm] = await db().query('SELECT id FROM forms WHERE is_default = 1 AND deleted_at IS NULL');
      if (defaultForm) expectError(await request(t.http).delete(`${BASE}/${defaultForm.id}`).set(admin.headers), 409, 'FORM_DEFAULT_REQUIRED');

      await request(t.http).delete(`${BASE}/${form.id}`).set(admin.headers).expect(204);
      expectError(await request(t.http).get(`${BASE}/${form.id}`).set(admin.headers), 404, 'FORM_NOT_FOUND');
      expect(await audited('form.deleted', form.id)).toBeTruthy();
      await create({ slug: form.slug }).expect(201);
    });
  });
});

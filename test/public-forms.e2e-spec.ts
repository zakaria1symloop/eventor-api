import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { AcademicRequest } from '../src/academic/entities/academic-request.entity.js';
import type { FormSchema } from '../src/academic/entities/form-version.entity.js';
import { starterSchema } from '../src/academic/form-schema.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { MailService } from '../src/mail/mail.service.js';
import { createApp, expectError, loginAs, makeCategory, makeUser, uid, type LoggedIn, type TestApp } from './utils/index.js';

const PUBLIC = '/api/v1/forms';
const ADMIN = '/api/v1/admin/forms';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0a60000000049454e44ae426082', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24)]);

const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('Public forms (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;
  let categoryId: string;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
    categoryId = (await makeCategory(t.dataSource)).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const outbox = () => t.get(MailService).outbox;
  const lastMailTo = (email: string) => [...outbox()].reverse().find((m) => m.to === email);
  const email = () => `nadia.${uid()}@univ-alger.dz`;

  /** Starter schema + a type choice revealing a required "other" field + a PDF programme. */
  function schema(): FormSchema {
    const s = starterSchema();
    s.fields.push(
      { key: 'format', type: 'single_choice', label_en: 'Format', label_ar: 'الصيغة', options: [{ value: 'onsite', label_en: 'On site', label_ar: 'حضوري' }, { value: 'other', label_en: 'Other', label_ar: 'أخرى' }] },
      { key: 'format_other', type: 'short_text', label_en: 'Which format?', label_ar: 'أي صيغة؟', required: true, showIf: { field: 'format', equals: 'other' } },
      { key: 'programme', type: 'file', label_en: 'Programme', label_ar: 'البرنامج', validation: { maxFiles: 1, types: ['pdf'] } },
    );
    return s;
  }

  async function liveForm(settings: Record<string, unknown> = {}) {
    const form = (await request(t.http).post(ADMIN).set(admin.headers).send({ nameEn: `Science Day ${uid()}`, nameAr: 'اليوم العلمي' }).expect(201)).body.data;
    await request(t.http).put(`${ADMIN}/${form.id}/draft`).set(admin.headers).send({ schema: schema() }).expect(200);
    await request(t.http).post(`${ADMIN}/${form.id}/publish`).set(admin.headers).expect(200);
    if (Object.keys(settings).length) await request(t.http).patch(`${ADMIN}/${form.id}`).set(admin.headers).send(settings).expect(200);
    return form as { id: string; slug: string };
  }

  const answers = (overrides: Record<string, unknown> = {}) => ({
    full_name: 'Nadia Hamdi',
    phone: '0555 12 34 56',
    institution: "Université d'Alger 1",
    title: 'Science Day 2026',
    event_type: 'academic',
    event_date: addDays(30),
    wilaya: 16,
    attendees: 350,
    needs: [categoryId],
    budget: { min: 150000, max: 400000 },
    format: 'onsite',
    ...overrides,
  });

  async function codeFor(slug: string, address: string): Promise<string> {
    await request(t.http).post(`${PUBLIC}/${slug}/email-code`).send({ email: address }).expect(201);
    return /:\s*(\d{6})\b/.exec(lastMailTo(address)!.text)![1]!;
  }

  function uploadPdf(slug: string, buffer = PDF, name = 'programme.pdf') {
    return request(t.http).post(`${PUBLIC}/${slug}/uploads`).attach('file', buffer, name);
  }

  const submit = (slug: string, body: Record<string, unknown>) => request(t.http).post(`${PUBLIC}/${slug}/submissions`).send(body);

  describe('GET /forms/:slug', () => {
    it('returns the live version without a token; 404 draft / unknown, 410 closed', async () => {
      const form = await liveForm({ maxSubmissionsPerEmailPerMonth: 2 });
      const res = await request(t.http).get(`${PUBLIC}/${form.slug}`).expect(200);
      expect(res.body.data).toMatchObject({ slug: form.slug, version: 1, requiresAuth: false, maxSubmissionsPerEmailPerMonth: 2, uploadMaxMb: 5, confirmationEn: expect.any(String) });
      expect(res.body.data.schema.fields.map((f: any) => f.key)).toContain('format_other');

      const draft = (await request(t.http).post(ADMIN).set(admin.headers).send({ nameEn: `Draft ${uid()}`, nameAr: 'مسودة' }).expect(201)).body.data;
      expectError(await request(t.http).get(`${PUBLIC}/${draft.slug}`), 404, 'FORM_NOT_FOUND');
      expectError(await request(t.http).get(`${PUBLIC}/nope-${uid()}`), 404, 'FORM_NOT_FOUND');
      await request(t.http).post(`${ADMIN}/${form.id}/close`).set(admin.headers).expect(200);
      const closed = await request(t.http).get(`${PUBLIC}/${form.slug}`).set('Accept-Language', 'ar');
      expectError(closed, 410, 'FORM_CLOSED');
      expect(closed.body.message).toBe('هذا النموذج لم يعد يستقبل الطلبات.');
    });
  });

  describe('POST /forms/:slug/email-code', () => {
    it('emails a 6-digit code in the Accept-Language language; resend waits 60 s', async () => {
      const form = await liveForm();
      const address = email();
      const res = await request(t.http).post(`${PUBLIC}/${form.slug}/email-code`).set('Accept-Language', 'ar').send({ email: address.toUpperCase() }).expect(201);
      expect(res.body.data).toEqual({ email: address, expiresAt: expect.any(String), resendAfterSeconds: 60 });
      expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(lastMailTo(address)).toMatchObject({ subject: 'رمز التحقق الخاص بك', text: expect.stringMatching(/\d{6}/) });
      const [row] = await db().query("SELECT code_hash FROM verification_codes WHERE destination = ? AND purpose = 'form_submission'", [address]);
      expect(row.code_hash).not.toContain(/(\d{6})/.exec(lastMailTo(address)!.text)![1]);

      const again = await request(t.http).post(`${PUBLIC}/${form.slug}/email-code`).send({ email: address });
      expectError(again, 429, 'CODE_RESEND_TOO_SOON');
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
      expectError(await request(t.http).post(`${PUBLIC}/${form.slug}/email-code`).send({ email: 'nope' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${PUBLIC}/missing-${uid()}/email-code`).send({ email: address }), 404, 'FORM_NOT_FOUND');
    });
  });

  describe('POST /forms/:slug/uploads', () => {
    it('stores PDF / PNG privately and returns a token; refuses other types, big files and no file', async () => {
      const form = await liveForm();
      const res = await uploadPdf(form.slug).expect(201);
      expect(res.body.data).toMatchObject({ uploadToken: expect.stringMatching(/^[0-9a-f-]{36}\.\d{10}\.[\w-]{43}$/), fileName: 'programme.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length });
      const [file] = await db().query('SELECT purpose, is_private FROM files WHERE id = ?', [res.body.data.uploadToken.slice(0, 36)]);
      expect(file).toMatchObject({ purpose: 'attachment', is_private: 1 });
      await uploadPdf(form.slug, PNG, 'poster.png').expect(201);
      expectError(await uploadPdf(form.slug, WEBP, 'photo.webp'), 415, 'FILE_TYPE_NOT_ALLOWED');
      expectError(await uploadPdf(form.slug, Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)])), 413, 'FILE_TOO_LARGE');
      expectError(await request(t.http).post(`${PUBLIC}/${form.slug}/uploads`), 400, 'VALIDATION_FAILED');
    });
  });

  describe('POST /forms/:slug/submissions', () => {
    it('creates a pending request: mapped fields, needs, attachment, linked account, audit, confirmation email, admin notification', async () => {
      const form = await liveForm();
      const existing = await makeUser(db(), { email: email() });
      const upload = (await uploadPdf(form.slug).expect(201)).body.data;
      const code = await codeFor(form.slug, existing.email);
      const res = await submit(form.slug, { email: existing.email, code, answers: answers(), uploads: [{ fieldKey: 'programme', uploadToken: upload.uploadToken }] })
        .set('Accept-Language', 'ar')
        .expect(201);
      expect(res.body.data).toMatchObject({ reference: expect.stringMatching(/^ACR-\d{6}$/), status: 'pending', confirmationAr: expect.any(String) });

      const row = await db().getRepository(AcademicRequest).findOneByOrFail({ reference: res.body.data.reference });
      expect(row).toMatchObject({
        formId: form.id,
        requesterId: existing.id,
        requesterEmail: existing.email,
        requesterName: 'Nadia Hamdi',
        requesterPhone: '0555123456',
        institutionName: "Université d'Alger 1",
        title: 'Science Day 2026',
        eventType: 'academic',
        wilayaCode: 16,
        attendees: 350,
        budgetMin: '150000.00',
        budgetMax: '400000.00',
      });
      expect(row.answers).toMatchObject({ programme: [upload.uploadToken.slice(0, 36)] });
      expect(await db().query('SELECT category_id FROM academic_request_needs WHERE request_id = ?', [row.id])).toEqual([{ category_id: categoryId }]);
      expect(await db().query('SELECT field_key, file_id FROM academic_request_attachments WHERE request_id = ?', [row.id])).toEqual([{ field_key: 'programme', file_id: upload.uploadToken.slice(0, 36) }]);
      expect(await db().getRepository(AuditLog).findOneBy({ action: 'academic_request.submitted', objectId: row.id })).toMatchObject({ source: 'web', changes: expect.objectContaining({ lang: 'ar' }) });
      expect(lastMailTo(existing.email)!.subject).toBe(`تم إرسال طلبك ${row.reference}`);
      const [{ n }] = await db().query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'academic_request.new'", [admin.user.id]);
      expect(Number(n)).toBeGreaterThan(0);

      // The code is single-use; the upload token cannot be reused either.
      expectError(await submit(form.slug, { email: existing.email, code, answers: answers() }), 422, 'CODE_INVALID');
      const other = email();
      expectError(await submit(form.slug, { email: other, code: await codeFor(form.slug, other), answers: answers(), uploads: [{ fieldKey: 'programme', uploadToken: upload.uploadToken }] }), 422, 'UPLOAD_TOKEN_INVALID');
    });

    it('validates answers server-side incl. showIf, required and file constraints', async () => {
      const form = await liveForm();
      const address = email();
      const png = (await uploadPdf(form.slug, PNG, 'poster.png').expect(201)).body.data;
      const res = await submit(form.slug, {
        email: address,
        code: '000000',
        answers: answers({ format: 'other', event_date: addDays(2), wilaya: 99, unknown: 1, title: '' }),
        uploads: [{ fieldKey: 'programme', uploadToken: png.uploadToken }],
      });
      expectError(res, 422, 'FORM_ANSWERS_INVALID');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          { fieldKey: 'unknown', code: 'UNKNOWN_FIELD' },
          { fieldKey: 'title', code: 'REQUIRED' },
          { fieldKey: 'event_date', code: 'DATE_TOO_EARLY' },
          { fieldKey: 'wilaya', code: 'WILAYA_INVALID' },
          { fieldKey: 'format_other', code: 'REQUIRED' },
          { fieldKey: 'programme', code: 'FILE_TYPE_NOT_ALLOWED' },
        ]),
      );
      const shown = await submit(form.slug, { email: address, code: await codeFor(form.slug, address), answers: answers({ format: 'other', format_other: 'Hybrid' }) }).expect(201);
      const row = await db().getRepository(AcademicRequest).findOneByOrFail({ reference: shown.body.data.reference });
      expect(row.answers).toMatchObject({ format_other: 'Hybrid' });
      expect(row.requesterId).toBeNull();
    });

    it('checks forged upload tokens, the code (wrong, attempts, expired) and body validation', async () => {
      const form = await liveForm();
      const otherForm = await liveForm();
      const address = email();
      const foreign = (await uploadPdf(otherForm.slug).expect(201)).body.data;
      expectError(await submit(form.slug, { email: address, code: '123456', answers: answers(), uploads: [{ fieldKey: 'programme', uploadToken: foreign.uploadToken }] }), 422, 'UPLOAD_TOKEN_INVALID');
      expectError(await submit(form.slug, { email: address, code: '123456', answers: answers(), uploads: [{ fieldKey: 'programme', uploadToken: 'x.y.z' }] }), 422, 'UPLOAD_TOKEN_INVALID');

      expectError(await submit(form.slug, { email: address, code: '123456', answers: answers() }), 422, 'CODE_INVALID');
      const code = await codeFor(form.slug, address);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expectError(await submit(form.slug, { email: address, code: wrong, answers: answers() }), 422, 'CODE_INVALID');
      expectError(await submit(form.slug, { email: address, code, answers: answers() }), 422, 'CODE_EXPIRED');

      const late = email();
      const lateCode = await codeFor(form.slug, late);
      await db().query('UPDATE verification_codes SET expires_at = ? WHERE destination = ?', [new Date(Date.now() - 1000), late]);
      const expired = await submit(form.slug, { email: late, code: lateCode, answers: answers() }).set('Accept-Language', 'ar');
      expectError(expired, 422, 'CODE_EXPIRED');
      expect(expired.body.message).toBe('انتهت صلاحية رمز التحقق. اطلب رمزًا جديدًا.');

      const bad = await submit(form.slug, { email: 'x', code: '12', extra: true });
      expectError(bad, 400, 'VALIDATION_FAILED');
      expect(bad.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['email', 'code', 'answers', 'extra']));
    });

    it('enforces the monthly limit per email and forms that require an account', async () => {
      const form = await liveForm({ maxSubmissionsPerEmailPerMonth: 1 });
      const address = email();
      await submit(form.slug, { email: address, code: await codeFor(form.slug, address), answers: answers() }).expect(201);
      await db().query('UPDATE verification_codes SET created_at = ? WHERE destination = ?', [new Date(Date.now() - 120_000), address]);
      const limited = await submit(form.slug, { email: address, code: await codeFor(form.slug, address), answers: answers() });
      expectError(limited, 429, 'FORM_SUBMISSION_LIMIT');
      expect(limited.body.details).toEqual({ limit: 1 });

      const locked = await liveForm({ requiresAuth: true });
      expectError(await submit(locked.slug, { email: email(), code: '123456', answers: answers() }), 422, 'FORM_REQUIRES_ACCOUNT');
      const member = await makeUser(db(), { email: email() });
      await submit(locked.slug, { email: member.email, code: await codeFor(locked.slug, member.email), answers: answers() }).expect(201);
    });

    it('refuses closed forms', async () => {
      const form = await liveForm();
      await request(t.http).post(`${ADMIN}/${form.id}/close`).set(admin.headers).expect(200);
      expectError(await submit(form.slug, { email: email(), code: '123456', answers: answers() }), 410, 'FORM_CLOSED');
    });
  });

  describe('edit link (changes requested)', () => {
    it('opens the request with its version, validates, resubmits to pending with changed fields, single use', async () => {
      const form = await liveForm();
      const address = email();
      const upload = (await uploadPdf(form.slug).expect(201)).body.data;
      const sent = await submit(form.slug, { email: address, code: await codeFor(form.slug, address), answers: answers(), uploads: [{ fieldKey: 'programme', uploadToken: upload.uploadToken }] }).expect(201);
      const reference = sent.body.data.reference;

      // A new version does not affect the request's own version.
      const v2 = schema();
      v2.fields = v2.fields.filter((f) => f.key !== 'format_other');
      await request(t.http).put(`${ADMIN}/${form.id}/draft`).set(admin.headers).send({ schema: v2 }).expect(200);
      await request(t.http).post(`${ADMIN}/${form.id}/publish`).set(admin.headers).expect(200);

      await request(t.http).post(`/api/v1/admin/academic-requests/${reference}/request-changes`).set(admin.headers).send({ fields: ['attendees'], message: 'Please confirm the attendees.' }).expect(200);
      const mail = lastMailTo(address)!;
      const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]!);
      expect(mail.text).toContain(`/f/${form.slug}/edit?token=`);

      const open = await request(t.http).get(`${PUBLIC}/${form.slug}/requests/${encodeURIComponent(token)}`).expect(200);
      expect(open.body.data).toMatchObject({ reference, status: 'changes_requested', version: 1, requestedChanges: { fields: ['attendees'], message: 'Please confirm the attendees.' }, email: address });
      expect(open.body.data.schema.fields.map((f: any) => f.key)).toContain('format_other');

      const edit = (body: Record<string, unknown>, slug = form.slug) => request(t.http).patch(`${PUBLIC}/${slug}/requests/${encodeURIComponent(token)}`).send(body);
      expectError(await edit({ answers: answers({ attendees: -4 }) }), 422, 'FORM_ANSWERS_INVALID');
      expectError(await edit({ answers: answers() }, `other-${uid()}`), 404, 'EDIT_LINK_INVALID');
      const done = await edit({ answers: answers({ attendees: 420 }) }).expect(200);
      expect(done.body.data).toMatchObject({ reference, status: 'pending' });

      const row = await db().getRepository(AcademicRequest).findOneByOrFail({ reference });
      expect(row).toMatchObject({ status: 'pending', attendees: 420 });
      expect(row.answers).toMatchObject({ programme: [upload.uploadToken.slice(0, 36)] });
      const detail = await request(t.http).get(`/api/v1/admin/academic-requests/${row.id}`).set(admin.headers).expect(200);
      expect(detail.body.data.changedFields).toEqual(['attendees']);
      expect(detail.body.data.answers.find((a: any) => a.key === 'attendees')).toMatchObject({ value: 420, changed: true });
      expect(detail.body.data.form.version).toBe(1);
      expect(await db().getRepository(AuditLog).findOneBy({ action: 'academic_request.resubmitted', objectId: row.id })).toBeTruthy();

      expectError(await edit({ answers: answers() }), 404, 'EDIT_LINK_INVALID');
      expectError(await request(t.http).get(`${PUBLIC}/${form.slug}/requests/not-a-token`), 404, 'EDIT_LINK_INVALID');
    });
  });
});

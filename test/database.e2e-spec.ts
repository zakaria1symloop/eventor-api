import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuditLevel } from '../src/common/enums/admin.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { runInTransaction } from '../src/database/transaction.js';
import { SequencesService } from '../src/sequences/sequences.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import {
  createApp,
  makeAcademicRequest,
  makeAuditLog,
  makeBooking,
  makeCommune,
  makeDispute,
  makeFile,
  makeInvoice,
  makeMessage,
  makeNotification,
  makePack,
  makeReport,
  makeSession,
  makeUser,
  makeUserDocument,
  type TestApp,
} from './utils/index.js';

describe('Database foundation (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('has the seeded reference data', async () => {
    const [{ wilayas }] = await t.dataSource.query('SELECT COUNT(*) AS wilayas FROM wilayas');
    expect(Number(wilayas)).toBe(58);
    const [alger] = await t.dataSource.query('SELECT name, name_ar, region FROM wilayas WHERE code = 16');
    expect(alger).toEqual({ name: 'Alger', name_ar: 'الجزائر', region: 'north_centre' });

    const settings = t.get(SettingsService);
    await expect(settings.get('platform_fee_percent')).resolves.toBe(10);
    await expect(settings.get('allowed_image_types')).resolves.toEqual(['jpeg', 'png', 'webp', 'heic']);
  });

  it('allocates unique, gap-free references under concurrency', async () => {
    const sequences = t.get(SequencesService);
    const refs = await Promise.all(Array.from({ length: 12 }, () => sequences.next('dispute')));
    const numbers = refs.map((ref) => Number(ref.slice(4))).sort((a, b) => a - b);
    expect(new Set(refs).size).toBe(12);
    expect(numbers.at(-1)! - numbers[0]!).toBe(11);
    refs.forEach((ref) => expect(ref).toMatch(/^DSP-\d{6}$/));
  });

  it('gives the number back when the transaction rolls back', async () => {
    const sequences = t.get(SequencesService);
    const before = await sequences.next('academic_request');
    await expect(
      runInTransaction(t.dataSource, async (em) => {
        await sequences.next('academic_request', em);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const after = await sequences.next('academic_request');
    expect(Number(after.slice(4))).toBe(Number(before.slice(4)) + 1);
  });

  it('creates the invoice row for the year on first use', async () => {
    const ref = await t.get(SequencesService).next('invoice', undefined, new Date('2031-03-01T00:00:00Z'));
    expect(ref).toBe('INV-2031-0001');
  });

  it('writes audit entries inside the transaction and runs afterCommit only on commit', async () => {
    const audit = t.get(AuditService);
    const admin = await makeUser(t.dataSource, { role: UserRole.Admin });
    const committed = vi.fn();
    const rolledBack = vi.fn();

    await runInTransaction(t.dataSource, async (em, afterCommit) => {
      await audit.log(
        { actorId: admin.id, action: 'test.commit', objectType: 'user', objectId: admin.id, level: AuditLevel.Sensitive },
        em,
      );
      afterCommit(committed);
    });
    await expect(
      runInTransaction(t.dataSource, async (em, afterCommit) => {
        await audit.log({ actorId: admin.id, action: 'test.rollback', objectType: 'user', objectId: admin.id }, em);
        afterCommit(rolledBack);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    const rows = await t.dataSource.getRepository(AuditLog).find({ where: { actorId: admin.id } });
    expect(rows.map((r) => [r.action, r.level, r.source])).toEqual([['test.commit', 'sensitive', 'system']]);
    expect(committed).toHaveBeenCalledOnce();
    expect(rolledBack).not.toHaveBeenCalled();
  });

  it('evaluates DB-defaulted timestamps in UTC (session time_zone +00:00)', async () => {
    const [{ tz }] = await t.dataSource.query('SELECT @@session.time_zone AS tz');
    expect(tz).toBe('+00:00');
    const before = Date.now();
    const row = await makeAuditLog(t.dataSource);
    const [raw] = await t.dataSource.query('SELECT created_at FROM audit_logs WHERE id = ?', [row.id]);
    for (const value of [row.createdAt, raw.created_at as Date]) {
      expect(Math.abs(value.getTime() - before)).toBeLessThan(5_000);
    }
    // Explicit JS timestamps keep round-tripping unchanged.
    const explicit = new Date('2026-09-15T10:00:00.000Z');
    const session = await makeSession(t.dataSource, { userId: (await makeUser(t.dataSource)).id, expiresAt: explicit });
    const [stored] = await t.dataSource.query('SELECT expires_at FROM sessions WHERE id = ?', [session.id]);
    expect((stored.expires_at as Date).toISOString()).toBe(explicit.toISOString());
  });

  it('factories create every main entity against the real schema', async () => {
    const db = t.dataSource;
    await makeSession(db, { userId: (await makeUser(db)).id });
    await makeUserDocument(db);
    await makeCommune(db);
    await makeFile(db);
    await makePack(db);
    await makeInvoice(db);
    await makeAcademicRequest(db);
    await makeDispute(db);
    await makeReport(db);
    await makeMessage(db);
    await makeNotification(db);
    await makeAuditLog(db);
    const booking = await makeBooking(db);
    expect(booking.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

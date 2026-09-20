import request from 'supertest';
import { Wilaya } from '../src/catalog/entities/wilaya.entity.js';
import { createApp, makeCategory, uid, type TestApp } from './utils/index.js';

describe('Public catalogue (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('GET /public/categories: visible, not deleted, by position, no token', async () => {
    const tag = uid();
    const shown = await makeCategory(t.dataSource, { slug: `shown-${tag}`, nameEn: `Shown ${tag}`, position: 250 });
    const hidden = await makeCategory(t.dataSource, { slug: `hidden-${tag}`, isVisible: false });
    const deleted = await makeCategory(t.dataSource, { slug: `deleted-${tag}` });
    await t.dataSource.query('UPDATE categories SET deleted_at = NOW() WHERE id = ?', [deleted.id]);

    const res = await request(t.http).get('/api/v1/public/categories').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const ids = res.body.data.map((c: any) => c.id);
    expect(ids).toContain(shown.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(deleted.id);
    expect(res.body.data.find((c: any) => c.id === shown.id)).toEqual({ id: shown.id, slug: `shown-${tag}`, nameEn: `Shown ${tag}`, nameAr: shown.nameAr, icon: 'sparkles', position: 250 });
    const positions = res.body.data.map((c: any) => c.position);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('GET /public/wilayas: open wilayas by code', async () => {
    const repo = t.dataSource.getRepository(Wilaya);
    const original = await repo.findBy([{ code: 16 }, { code: 58 }]);
    await repo.update({ code: 58 }, { isOpen: false });
    await repo.update({ code: 16 }, { isOpen: true });
    const res = await request(t.http).get('/api/v1/public/wilayas').expect(200);
    const codes = res.body.data.map((w: any) => w.code);
    expect(codes).toContain(16);
    expect(codes).not.toContain(58);
    expect([...codes].sort((a, b) => a - b)).toEqual(codes);
    expect(res.body.data.find((w: any) => w.code === 16)).toEqual({ code: 16, name: expect.any(String), nameAr: expect.any(String) });
    for (const w of original) await repo.update({ code: w.code }, { isOpen: w.isOpen });
  });
});

/**
 * `bullmq` declares `ioredis` as an *optional* peer dependency, so a install
 * without it type-checks, builds, and passes every test that mocks `bullmq` —
 * and then crashes at boot on the first server that actually sets `REDIS_URL`
 * ("BullMQ could not load the optional 'ioredis' package"). The dev machine
 * never noticed because `REDIS_URL` is empty there and the inline driver hides
 * the gap.
 *
 * This test buys nothing but that guarantee: the real package is installed and
 * loadable, at a major version both `bullmq` (>= 5) and `typeorm` (^5) accept.
 */
import { describe, expect, it } from 'vitest';

describe('Redis driver', () => {
  it('has ioredis installed, so a REDIS_URL deployment can boot', async () => {
    const ioredis = await import('ioredis');
    expect(typeof (ioredis.default ?? ioredis.Redis)).toBe('function');
  });

  it('is on a major version bullmq and typeorm both accept', async () => {
    const { default: pkg } = await import('ioredis/package.json', { with: { type: 'json' } });
    expect(Number(pkg.version.split('.')[0])).toBe(5);
  });
});

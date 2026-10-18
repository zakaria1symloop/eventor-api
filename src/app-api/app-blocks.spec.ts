/** Blocking users: who is blocked in which direction, and what the endpoints refuse. The database is a fake. */
import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '../common/enums/user.enums.js';
import { AppBlocksService, assertNotBlocked, blockSets } from './app-blocks.service.js';

const ME = 'me';
const auth = { id: ME, role: UserRole.Client } as any;

/** A fake db answering the user_blocks queries from a list of [blocker, blocked] pairs. */
function db(pairs: [string, string][], users: Record<string, { id: string; role: string }> = {}) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT blocker_id, blocked_id FROM user_blocks')) {
        const [me, others] = params as [string, string[]];
        return pairs
          .filter(([a, b]) => (a === me && others.includes(b)) || (b === me && others.includes(a)))
          .map(([a, b]) => ({ blocker_id: a, blocked_id: b }));
      }
      if (sql.startsWith('SELECT id, role FROM users')) return users[params[0] as string] ? [users[params[0] as string]] : [];
      if (sql.startsWith('DELETE FROM user_blocks')) return { affectedRows: pairs.some(([a, b]) => a === params[0] && b === params[1]) ? 1 : 0 };
      if (sql.startsWith('INSERT IGNORE INTO user_blocks')) return { affectedRows: 1 };
      if (sql.startsWith('SELECT c.id FROM conversations c')) return [{ id: 'chat-1' }];
      return [{ user_id: params[1], created_at: new Date('2026-10-15T10:00:00Z'), full_name: 'Amina', role: 'client', avatar_file_id: null, business_name: null }];
    }),
  };
}

describe('blockSets / assertNotBlocked', () => {
  it('sees both directions', async () => {
    const sets = await blockSets(db([[ME, 'a'], ['b', ME], ['c', 'd']]), ME, ['a', 'b', 'c']);
    expect([...sets.byMe]).toEqual(['a']);
    expect([...sets.me]).toEqual(['b']);
  });

  it('refuses when either side blocked the other, and says which', async () => {
    await expect(assertNotBlocked(db([[ME, 'a']]), ME, ['a'])).rejects.toMatchObject({ code: 'USER_BLOCKED', details: { blockedByMe: true } });
    await expect(assertNotBlocked(db([['a', ME]]), ME, ['a'])).rejects.toMatchObject({ code: 'USER_BLOCKED', details: { blockedByMe: false } });
    await expect(assertNotBlocked(db([['a', 'b']]), ME, ['a'])).resolves.toBeUndefined();
    await expect(assertNotBlocked(db([]), ME, [])).resolves.toBeUndefined();
  });
});

describe('AppBlocksService', () => {
  const events = { emit: vi.fn(async () => undefined) };
  const service = (fake: ReturnType<typeof db>) => new AppBlocksService(fake as any, { signedUrl: () => 'url' } as any, events as any);

  it('blocks a client or provider and answers the blocked user', async () => {
    const fake = db([], { u1: { id: 'u1', role: 'provider' } });
    await expect(service(fake).block(auth, 'u1')).resolves.toEqual({ id: 'u1', name: 'Amina', avatarUrl: null, role: 'client', blockedAt: '2026-10-15T10:00:00.000Z' });
    expect(fake.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT IGNORE INTO user_blocks'))).toBe(true);
  });

  it('refuses yourself, Eventor admins and unknown users', async () => {
    const fake = db([], { [ME]: { id: ME, role: 'client' }, admin: { id: 'admin', role: 'admin' } });
    await expect(service(fake).block(auth, ME)).rejects.toMatchObject({ code: 'BLOCK_TARGET_INVALID' });
    await expect(service(fake).block(auth, 'admin')).rejects.toMatchObject({ code: 'BLOCK_TARGET_INVALID' });
    await expect(service(fake).block(auth, 'nobody')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('tells both sides of their direct chat, on block and on unblock', async () => {
    events.emit.mockClear();
    await service(db([], { u1: { id: 'u1', role: 'provider' } })).block(auth, 'u1');
    await service(db([[ME, 'u1']])).unblock(auth, 'u1');
    expect(events.emit.mock.calls).toEqual([
      ['conversation.updated', { conversationId: 'chat-1', reason: 'blocked' }],
      ['conversation.updated', { conversationId: 'chat-1', reason: 'unblocked' }],
    ]);
  });

  it('unblocks only an existing block', async () => {
    await expect(service(db([[ME, 'u1']])).unblock(auth, 'u1')).resolves.toBeUndefined();
    await expect(service(db([])).unblock(auth, 'u1')).rejects.toMatchObject({ code: 'BLOCK_NOT_FOUND' });
  });
});

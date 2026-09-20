import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque refresh tokens: `<sessionId>.<r>.<secret>` where `r` is 1 when the
 * user asked to be remembered. Only the SHA-256 of the whole token is stored
 * (`sessions.token_hash`), so the flag cannot be tampered with.
 *
 * Rotation keeps one session row per sign-in (its id is the access token's
 * `sid`) and replaces the hash on every refresh. A token whose session exists
 * but whose hash no longer matches is an old, already-rotated token being
 * replayed: the whole session (the family) is revoked.
 */
export interface ParsedRefreshToken {
  sessionId: string;
  remember: boolean;
  token: string;
}

const FORMAT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([01])\.([A-Za-z0-9_-]{43})$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createRefreshToken(sessionId: string, remember: boolean): { token: string; hash: string } {
  const token = `${sessionId}.${remember ? 1 : 0}.${randomSecret()}`;
  return { token, hash: hashToken(token) };
}

export function parseRefreshToken(value: unknown): ParsedRefreshToken | null {
  if (typeof value !== 'string') return null;
  const match = FORMAT.exec(value);
  if (!match) return null;
  return { sessionId: match[1]!, remember: match[2] === '1', token: value };
}

export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type RotationDecision = 'rotate' | 'reuse_detected' | 'invalid';

/** What a refresh does with a presented token, given its session row. */
export function decideRotation(
  session: { tokenHash: string; revokedAt: Date | null; expiresAt: Date } | null,
  token: string,
  now = new Date(),
): RotationDecision {
  if (!session) return 'invalid';
  const matches = tokenMatchesHash(token, session.tokenHash);
  if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return 'invalid';
  return matches ? 'rotate' : 'reuse_detected';
}

/** `<id>.<secret>` single-use tokens (password reset) looked up by primary key. */
export function createKeyedToken(id: string): { token: string; hash: string } {
  const token = `${id}.${randomSecret()}`;
  return { token, hash: hashToken(token) };
}

export function parseKeyedToken(value: unknown): { id: string; token: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/.exec(value);
  return match ? { id: match[1]!, token: value } : null;
}

/** "Chrome on Windows" from a user agent, for the sessions list. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return (browser ?? os ?? ua).slice(0, 120);
}

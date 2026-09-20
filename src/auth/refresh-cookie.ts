import type { CookieOptions, Request, Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { NodeEnv, type Env } from '../config/env.js';

/** The dashboard's refresh token cookie (tech-decisions → Auth). */
export const REFRESH_COOKIE = 'eventor_admin_rt';
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/admin/auth`;
export const REMEMBER_TTL_MS = 30 * 86_400_000;
/** Server-side lifetime of a session without "remember me", extended on each refresh. */
export const SESSION_TTL_MS = 86_400_000;

function baseOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === NodeEnv.Production,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  };
}

/** Persistent for 30 days with "remember me", otherwise a browser-session cookie. */
export function setRefreshCookie(res: Response, token: string, remember: boolean, env: Env): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions(env),
    ...(remember ? { maxAge: REMEMBER_TTL_MS } : {}),
  });
}

export function clearRefreshCookie(res: Response, env: Env): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions(env));
}

/** Reads the cookie without cookie-parser. */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === REFRESH_COOKIE) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

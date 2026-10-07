/**
 * The per-route-group rate limits, in one place so every route that belongs to a
 * group shares the same numbers. The global default (`THROTTLE_LIMIT`, 100/min)
 * comes from `ThrottlerModule` in AppModule; these override it per route.
 *
 * The limits are read from `process.env` lazily, as `@Throttle` is evaluated at
 * class-decoration time, before `ConfigModule` has validated the environment.
 */

/** `/admin/auth/*` and the public form code / submit routes: `AUTH_THROTTLE_LIMIT` (10) per minute. */
export const AUTH_THROTTLE = {
  default: { limit: () => Number(process.env.AUTH_THROTTLE_LIMIT) || 10, ttl: 60_000 },
};

/** Public form endpoints that send an email or create a request: same budget as auth. */
export const FORM_THROTTLE = AUTH_THROTTLE;

/** `POST /app/me/device-tokens/test` (a setup check that calls FCM): same budget as auth. */
export const PUSH_TEST_THROTTLE = AUTH_THROTTLE;

/** Every multipart upload route: `UPLOAD_THROTTLE_LIMIT` (30) per minute. */
export const UPLOAD_THROTTLE = {
  default: { limit: () => Number(process.env.UPLOAD_THROTTLE_LIMIT) || 30, ttl: 60_000 },
};

/**
 * Routes whose side effect is sending mail to a third party (admin invitations,
 * re-sends, verification decisions with a notice). Deliberately tighter than the
 * global default so a compromised admin session cannot be used as a mail relay.
 */
export const MAIL_THROTTLE = {
  default: { limit: () => Number(process.env.MAIL_THROTTLE_LIMIT) || 20, ttl: 60_000 },
};

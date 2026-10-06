import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { API_PREFIX } from '../app.setup.js';
import { OPENAPI_PUBLIC_EXTENSION } from '../auth/decorators/public.decorator.js';
import { ErrorResponseDto, FieldErrorDto } from '../common/swagger/api-error-responses.decorator.js';
import { PageMeta } from '../common/pagination/paginated.js';

export const DOCS_PATH = `${API_PREFIX}/docs`;
/** Mobile-only view of the same API, so the app developer isn't buried in admin routes. */
export const MOBILE_DOCS_PATH = `${DOCS_PATH}/mobile`;
/** Admin-only view, for the dashboard developer. */
export const ADMIN_DOCS_PATH = `${DOCS_PATH}/admin`;

/**
 * Tag order shown in Swagger UI. Mobile (`app-*`) first, then shared, then admin:
 * Swagger UI sorts by this list when it is present, instead of alphabetically.
 */
const TAG_ORDER: ReadonlyArray<[name: string, description: string]> = [
  ['app-auth', 'Mobile app: register, email code, login, tokens, password'],
  ['app-catalog', 'Mobile app: home, categories, search, services, providers, packs'],
  ['app-me', 'Mobile app: profile, documents, favourites, budget, notifications'],
  ['app-bookings', 'Mobile app: quote, book, the Bookings tab, cancel, reschedule, check-in, invoice'],
  ['app-provider', 'Mobile app: provider home, requests, services, packs, calendar, profile, reviews received'],
  ['app-messages', 'Mobile app: conversations, chat, read receipts and reports'],
  ['app-reviews', 'Mobile app: leave and edit a review, provider replies, disputes'],
  ['app-config', 'Mobile app: version, maintenance, limits, support and legal links'],
  ['public-catalog', 'Public: visible categories and open wilayas'],
  ['public-forms', 'Public: academic request forms and submissions'],
  ['files', 'Signed file and photo downloads'],
  ['health', 'Liveness and readiness'],
];

/** Shared by the running app and `pnpm spec:export`, so both describe the same API. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Eventor API')
    .setDescription(
      'API for the Eventor marketplace: the mobile app (`/api/v1/app/**`, tags `app-*`) and the admin dashboard (`/api/v1/admin/**`, tags `admin-*`). Separate views: `/api/v1/docs/mobile` and `/api/v1/docs/admin`.\n\n' +
        '- Routes are private by default: send `Authorization: Bearer <access token>`. Public routes say so.\n' +
        '- Single objects return `{ data }`; lists return `{ data, meta: { page, limit, total, totalPages } }`.\n' +
        '- Errors return `{ statusCode, error, code, message, details, path, timestamp, requestId }`; ' +
        '`message` follows `Accept-Language` (en | ar), `code` is stable.\n' +
        '- Money is a string with 2 decimals in DZD.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addGlobalParameters({
      name: 'Accept-Language',
      in: 'header',
      required: false,
      schema: { type: 'string', enum: ['en', 'ar'], default: 'en' },
    })
    .build();
  for (const [name, description] of TAG_ORDER) config.tags = [...(config.tags ?? []), { name, description }];

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorResponseDto, FieldErrorDto, PageMeta],
  });
  // Every route is private unless documented otherwise.
  document.security = [{ bearer: [] }];
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item ?? {})) {
      if (operation && typeof operation === 'object' && 'responses' in operation) {
        const op = operation as Record<string, unknown>;
        if (op[OPENAPI_PUBLIC_EXTENSION] === true) {
          op.security = [];
        }
      }
    }
  }
  return document;
}

/** Collects every `$ref` reachable from a JSON node (paths or a schema). */
function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
        into.add(value.slice('#/components/schemas/'.length));
      } else {
        collectRefs(value, into);
      }
    }
  }
}

/**
 * Drops every `components.schemas` entry not reachable from the document's
 * paths (walking `$ref`s transitively), so the mobile spec is not buried in
 * admin-only schemas and vice versa.
 */
function pruneComponents(document: OpenAPIObject): OpenAPIObject {
  const schemas = document.components?.schemas ?? {};
  const used = new Set<string>();
  collectRefs(document.paths, used);
  // Transitive closure: a kept schema may reference further schemas.
  // Iterating a Set visits entries added during the loop, so one pass closes the graph.
  for (const name of used) collectRefs(schemas[name], used);
  return {
    ...document,
    components: {
      ...document.components,
      schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name))),
    },
  };
}

/** §10 of docs/mobile-api.md, condensed for the spec header. */
const MOBILE_SOCKET_CONTRACT =
  '## Live updates: the Socket.IO namespace `/app`\n\n' +
  'Connect with `io("{API_URL}/app", { transports: ["websocket"], auth: { token: accessToken } })` — the same 15-minute ' +
  'app access token; a dashboard token is refused. A refused handshake fires `connect_error` whose `error.data.code` is an ' +
  'API error code (`AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_SESSION_REVOKED`, ' +
  '`ACCOUNT_BLOCKED`, `FORBIDDEN_AUDIENCE`, `FORBIDDEN_ROLE`). On success the server emits `ready` `{ userId, role }` and ' +
  'the socket automatically joins the caller\'s own room — no subscription needed for your own events.\n\n' +
  'Server → client events:\n' +
  '- `message:new` — an `AppMessageDto`, already masked **for you**.\n' +
  '- `conversation:updated` — `{ conversationId, reason }` (`message`, `read`, `created`, `closed`, …): refresh screen 14.\n' +
  '- `booking:updated` — `{ bookingId, reference, status }` whenever a booking of yours moves (created, accepted, declined, cancelled, completed, rescheduled, price changed); `status` is always the booking’s current status.\n' +
  '- `notification:new` — the same row `GET /app/me/notifications` returns (`AppNotificationDto`).\n\n' +
  'Client → server (acknowledged): `conversation:join` / `conversation:leave` `{ conversationId }` answering ' +
  '`{ ok: true, room }` or `{ ok: false, code: "NOT_A_PARTICIPANT" }`. Joining scopes nothing security-wise — it only lets ' +
  'screen 15 listen to a single conversation. Treat the socket as an optimisation, never as the source of truth.';

/** The same document with only the routes a mobile client can call. */
export function buildMobileOpenApiDocument(app: INestApplication): OpenAPIObject {
  const full = buildOpenApiDocument(app);
  const keep = (path: string): boolean =>
    path.startsWith(`${API_PREFIX}/app/`) ||
    path.startsWith(`${API_PREFIX}/public/`) ||
    path.startsWith(`${API_PREFIX}/forms/`) ||
    path.startsWith(`${API_PREFIX}/files/`) ||
    path === `${API_PREFIX}/health` ||
    path.startsWith(`${API_PREFIX}/health/`);
  const paths = Object.fromEntries(Object.entries(full.paths).filter(([path]) => keep(path)));
  return pruneComponents({
    ...full,
    info: {
      ...full.info,
      title: 'Eventor Mobile API',
      description:
        'The API the Eventor mobile app calls (`/api/v1/app/**`, plus the public forms, files and health routes). ' +
        'The full contract, with the traps, lives in `backend/docs/mobile-api.md`.\n\n' +
        '- Routes are private by default: send `Authorization: Bearer <app access token>`. Public routes say so.\n' +
        '- Send `Accept-Language: en|ar` on every request; localised objects carry the resolved field plus `*En`/`*Ar`.\n' +
        '- Single objects return `{ data }`; lists return `{ data, meta: { page, limit, total, totalPages } }` ' +
        '(chat messages use the cursor page `{ data, meta: { limit, hasMore, nextBefore } }`).\n' +
        '- Errors return `{ statusCode, error, code, message, details, path, timestamp, requestId }`; switch on `code`, show `message`.\n' +
        '- Money is a string with 2 decimals in DZD; timestamps are ISO 8601 UTC; event dates/times are Africa/Algiers.\n' +
        '- Photo/file URLs are signed and expire (~15 min): cache bytes by file id, never the URL.\n\n' +
        MOBILE_SOCKET_CONTRACT,
    },
    tags: (full.tags ?? []).filter((tag) => !tag.name.startsWith('admin-')),
    paths,
  });
}

/** The same document with only the routes the dashboard calls. */
export function buildAdminOpenApiDocument(app: INestApplication): OpenAPIObject {
  const full = buildOpenApiDocument(app);
  const keep = (path: string): boolean =>
    path.startsWith(`${API_PREFIX}/admin/`) ||
    path.startsWith(`${API_PREFIX}/files/`) ||
    path === `${API_PREFIX}/health` ||
    path.startsWith(`${API_PREFIX}/health/`);
  const paths = Object.fromEntries(Object.entries(full.paths).filter(([path]) => keep(path)));
  return pruneComponents({
    ...full,
    info: { ...full.info, title: 'Eventor Admin API' },
    tags: (full.tags ?? []).filter((tag) => !tag.name.startsWith('app-')),
    paths,
  });
}

export function setupSwagger(app: INestApplication): void {
  const swaggerOptions = {
    persistAuthorization: true,
    // Search box over tags, so 223 operations stay navigable.
    filter: true,
    tagsSorter: undefined,
    docExpansion: 'none' as const,
    // Links like /docs/mobile#/app-bookings/AppBookingsController_quote open that operation (used by the change notes).
    deepLinking: true,
  };
  SwaggerModule.setup(DOCS_PATH, app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: `${DOCS_PATH}/openapi.json`,
    customSiteTitle: 'Eventor API',
    swaggerOptions,
  });
  SwaggerModule.setup(MOBILE_DOCS_PATH, app, () => buildMobileOpenApiDocument(app), {
    jsonDocumentUrl: `${MOBILE_DOCS_PATH}/openapi.json`,
    customSiteTitle: 'Eventor Mobile API',
    swaggerOptions,
  });
  SwaggerModule.setup(ADMIN_DOCS_PATH, app, () => buildAdminOpenApiDocument(app), {
    jsonDocumentUrl: `${ADMIN_DOCS_PATH}/openapi.json`,
    customSiteTitle: 'Eventor Admin API',
    swaggerOptions,
  });
}

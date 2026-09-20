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
    .setTitle('Eventor Admin API')
    .setDescription(
      'Admin API for the Eventor event-services marketplace.\n\n' +
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

/** The same document with only the routes a mobile client can call. */
export function buildMobileOpenApiDocument(app: INestApplication): OpenAPIObject {
  const full = buildOpenApiDocument(app);
  const keep = (path: string): boolean =>
    path.startsWith(`${API_PREFIX}/app/`) ||
    path.startsWith(`${API_PREFIX}/public/`) ||
    path.startsWith(`${API_PREFIX}/forms/`) ||
    path.startsWith(`${API_PREFIX}/files/`) ||
    path.startsWith(`${API_PREFIX}/health/`);
  const paths = Object.fromEntries(Object.entries(full.paths).filter(([path]) => keep(path)));
  return {
    ...full,
    info: { ...full.info, title: 'Eventor Mobile API' },
    tags: (full.tags ?? []).filter((tag) => !tag.name.startsWith('admin-')),
    paths,
  };
}

/** The same document with only the routes the dashboard calls. */
export function buildAdminOpenApiDocument(app: INestApplication): OpenAPIObject {
  const full = buildOpenApiDocument(app);
  const keep = (path: string): boolean =>
    path.startsWith(`${API_PREFIX}/admin/`) ||
    path.startsWith(`${API_PREFIX}/files/`) ||
    path.startsWith(`${API_PREFIX}/health/`);
  const paths = Object.fromEntries(Object.entries(full.paths).filter(([path]) => keep(path)));
  return {
    ...full,
    info: { ...full.info, title: 'Eventor Admin API' },
    tags: (full.tags ?? []).filter((tag) => !tag.name.startsWith('app-')),
    paths,
  };
}

export function setupSwagger(app: INestApplication): void {
  const swaggerOptions = {
    persistAuthorization: true,
    // Search box over tags, so 223 operations stay navigable.
    filter: true,
    tagsSorter: undefined,
    docExpansion: 'none' as const,
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

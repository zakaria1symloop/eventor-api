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

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(DOCS_PATH, app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: `${DOCS_PATH}/openapi.json`,
    customSiteTitle: 'Eventor Admin API',
    swaggerOptions: { persistAuthorization: true },
  });
}

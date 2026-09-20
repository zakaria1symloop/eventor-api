import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { API_PREFIX } from '../app.setup.js';
import { buildOpenApiDocument } from '../config/swagger.js';

/**
 * Writes `openapi.json` at the backend root for the dashboard to generate its
 * typed client from. The app is built without connecting to the database or
 * Redis: only route metadata is read. Written with Node rather than a shell
 * redirect so the file has no byte-order mark.
 *
 * Usage: pnpm spec:export
 */
process.env.OPENAPI_EXPORT = '1';
process.env.LOG_REQUESTS = 'false';

const output = resolve(process.cwd(), 'openapi.json');
const app = await NestFactory.create(AppModule, { logger: ['error'] });
app.setGlobalPrefix(API_PREFIX);

try {
  const document = buildOpenApiDocument(app);
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const operations = Object.values(document.paths).reduce(
    (count, item) => count + Object.keys(item ?? {}).length,
    0,
  );
  console.log(`Wrote ${output} (${operations} operations)`);
} finally {
  await app.close();
}

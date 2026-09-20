import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test environment, applied before the app or any DataSource reads process.env:
 * the dev .env for credentials, then the test database, a throwaway storage
 * root, no Redis (inline queue), no SMTP (mails logged) and quiet request logs.
 */
try {
  process.loadEnvFile();
} catch {
  // CI: variables come from the environment.
}

process.env.NODE_ENV = 'test';
process.env.DB_DATABASE = process.env.DB_DATABASE_TEST || 'eventor_admin_test';
process.env.STORAGE_ROOT = join(tmpdir(), 'eventor-test-storage');
process.env.REDIS_URL = '';
process.env.SMTP_HOST = '';
process.env.LOG_REQUESTS = 'false';
process.env.THROTTLE_LIMIT = '100000';
process.env.AUTH_THROTTLE_LIMIT = '100000';
process.env.UPLOAD_THROTTLE_LIMIT = '100000';
process.env.MAIL_THROTTLE_LIMIT = '100000';
process.env.API_URL = 'http://localhost:3000';

export const TEST_STORAGE_ROOT = process.env.STORAGE_ROOT;

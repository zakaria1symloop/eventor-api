import { Logger as NestLogger } from '@nestjs/common';
import type { Logger as TypeOrmLogger } from 'typeorm';

const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 500);

/**
 * TypeORM logger outside development: failed and slow queries are logged with
 * their SQL only, never their parameters (password and token hashes, emails,
 * message bodies). TypeORM's built-in loggers print `-- PARAMETERS: [...]`.
 */
export class SafeQueryLogger implements TypeOrmLogger {
  private readonly logger = new NestLogger('Database');

  logQuery(): void {}

  logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
    const message = error instanceof Error ? error.message : error;
    this.logger.error(`query failed (${parameters?.length ?? 0} params): ${oneLine(query)} :: ${message}`);
  }

  logQuerySlow(time: number, query: string): void {
    this.logger.warn(`slow query ${time} ms: ${oneLine(query)}`);
  }

  logSchemaBuild(): void {}

  logMigration(message: string): void {
    this.logger.log(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown): void {
    if (level === 'warn') this.logger.warn(String(message));
  }
}

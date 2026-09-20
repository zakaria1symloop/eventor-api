import mysql from 'mysql2';
import type { DataSourceOptions } from 'typeorm';
import { NodeEnv, type Env } from '../config/env.js';
import { entities } from './entities.js';
import { migrations } from './migrations/index.js';
import { SafeQueryLogger } from './safe-query.logger.js';
import { SnakeNamingStrategy } from './naming.strategy.js';

/** Session time zone of every pooled connection. */
export const DB_SESSION_TIME_ZONE = '+00:00';

/**
 * mysql2 with a pool that sets `time_zone = '+00:00'` on every new connection.
 *
 * `timezone: 'Z'` only tells the driver how to convert JS dates; column defaults
 * (`CURRENT_TIMESTAMP(6)`), `NOW()` and `ON UPDATE` are evaluated by the server in
 * the *session* time zone, which defaults to the host's (UTC+1 on the dev
 * machine). Without this, DB-defaulted timestamps were read back one hour off.
 * The pool emits `connection` after the handshake and before the first query is
 * handed out, and mysql2 queues commands, so the SET always runs first.
 */
export const mysqlUtcDriver: typeof mysql = Object.assign(Object.create(mysql) as typeof mysql, {
  createPool: ((config: Parameters<typeof mysql.createPool>[0]) => {
    const pool = mysql.createPool(config);
    pool.on('connection', (connection) => {
      connection.query(`SET time_zone = '${DB_SESSION_TIME_ZONE}'`);
    });
    return pool;
  }) as typeof mysql.createPool,
});

/**
 * TypeORM options shared by the running app and the migration CLI, so both talk
 * to the same database with the same entity and migration lists.
 *
 * `synchronize` stays off: schema changes go through migrations, because
 * synchronize silently drops columns it no longer recognises.
 */
export function buildDataSourceOptions(env: Env): DataSourceOptions {
  return {
    type: 'mysql',
    driver: mysqlUtcDriver,
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    entities,
    migrations,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    // Development: TypeORM's console logger (prints parameters, handy locally).
    // Elsewhere: errors and queries slower than 1 s, SQL only, never parameters.
    logging: ['error', 'warn', 'migration'],
    ...(env.NODE_ENV === NodeEnv.Development ? {} : { logger: new SafeQueryLogger(), maxQueryExecutionTime: 1000 }),
  };
}

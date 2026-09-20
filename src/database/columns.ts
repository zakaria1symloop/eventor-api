import type { ColumnOptions } from 'typeorm';

/**
 * Money is `decimal(12,2)` in dinars. The mysql2 driver returns decimals as
 * strings; entities keep them as `string` everywhere so no precision is lost.
 * Convert at the edge (DTO / arithmetic helpers), never with parseFloat in SQL paths.
 */
export const money = (options: ColumnOptions = {}): ColumnOptions => ({
  type: 'decimal',
  precision: 12,
  scale: 2,
  ...options,
});

/** Cached average rating, `decimal(3,2) default 0`. */
export const rating = (): ColumnOptions => ({
  type: 'decimal',
  precision: 3,
  scale: 2,
  default: 0,
});

/** Cached counter, `int default 0`. */
export const counter = (): ColumnOptions => ({ type: 'int', default: 0 });

/**
 * FK column pointing at a UUID primary key. TypeORM's MySQL driver stores
 * `@PrimaryGeneratedColumn('uuid')` as `varchar(36)`, and MySQL requires FK
 * columns to have the same type, so references are `varchar(36)` too.
 */
export const uuidRef = (options: ColumnOptions = {}): ColumnOptions => ({
  type: 'varchar',
  length: 36,
  ...options,
});

/** FK column pointing at `wilayas.code`. */
export const wilayaRef = (options: ColumnOptions = {}): ColumnOptions => ({
  type: 'tinyint',
  unsigned: true,
  ...options,
});

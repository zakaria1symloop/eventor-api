import { CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Base for append-only rows (logs, history, join rows): a UUID key and
 * `created_at` only. These rows are inserted and never updated or soft-deleted.
 */
export abstract class AppendOnlyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}

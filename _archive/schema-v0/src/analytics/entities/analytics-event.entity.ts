import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AnalyticsEventType } from '../../common/enums/admin.enums.js';

/**
 * Client analytics events (api-decisions §3), table `events`. High-volume and
 * rolled up nightly, so `actor_id` / `subject_id` carry no foreign keys.
 */
@Entity('events')
@Index(['type', 'createdAt'])
export class AnalyticsEvent {
  /** bigint comes back from mysql2 as a string. */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id: string;

  @Column({ type: 'enum', enum: AnalyticsEventType })
  type: AnalyticsEventType;

  @Column({ type: 'char', length: 36, nullable: true })
  actorId: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  subjectId: string | null;

  @Column({ type: 'json' })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}

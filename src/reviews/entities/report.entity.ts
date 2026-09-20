import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import {
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from '../../common/enums/moderation.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Dispute } from '../../disputes/entities/dispute.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('reports')
@Index(['targetType', 'targetId'])
@Index(['status', 'createdAt'])
export class Report extends AbstractEntity {
  /** Null: automatic report from the flag scan (the system). */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reporter_id' })
  reporter: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  reporterId: string | null;

  @Column({ type: 'enum', enum: ReportTargetType })
  targetType: ReportTargetType;

  /** Polymorphic: no FK. */
  @Column({ type: 'char', length: 36 })
  targetId: string;

  @Column({ type: 'enum', enum: ReportReason })
  reason: ReportReason;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'enum', enum: ReportStatus, default: ReportStatus.Open })
  status: ReportStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'resolved_by_id' })
  resolvedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  resolvedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  resolutionNote: string | null;

  @ManyToOne(() => Dispute, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'dispute_id' })
  dispute: Relation<Dispute> | null;

  @Column(uuidRef({ nullable: true }))
  disputeId: string | null;
}

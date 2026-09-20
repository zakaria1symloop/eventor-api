import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Dispute } from './dispute.entity.js';

@Entity('dispute_events')
export class DisputeEvent extends AppendOnlyEntity {
  @ManyToOne(() => Dispute, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dispute_id' })
  dispute: Relation<Dispute>;

  @Column(uuidRef())
  disputeId: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_id' })
  actor: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  actorId: string | null;

  @Column({ type: 'varchar', length: 40 })
  type: string;

  @Column({ type: 'json', nullable: true })
  data: Record<string, unknown> | null;
}

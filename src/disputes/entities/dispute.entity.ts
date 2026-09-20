import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import {
  DisputeBookingOutcome,
  DisputeStatus,
  DisputeType,
} from '../../common/enums/moderation.enums.js';
import { PartyRole } from '../../common/enums/user.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Booking } from '../../bookings/entities/booking.entity.js';
import { Conversation } from '../../messaging/entities/conversation.entity.js';
import { User } from '../../users/entities/user.entity.js';

/** One open or in-review dispute per booking (checked by the API). */
@Entity('disputes')
@Index(['status', 'createdAt'])
@Index(['bookingId'])
@Index(['againstUserId'])
export class Dispute extends AbstractEntity {
  /** DSP-000031 */
  @Column({ type: 'varchar', length: 12, unique: true })
  reference: string;

  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef())
  bookingId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'opened_by_id' })
  openedBy: Relation<User>;

  @Column(uuidRef())
  openedById: string;

  @Column({ type: 'enum', enum: PartyRole })
  openedByRole: PartyRole;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'against_user_id' })
  againstUser: Relation<User>;

  @Column(uuidRef())
  againstUserId: string;

  @Column({ type: 'enum', enum: DisputeType })
  type: DisputeType;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'enum', enum: DisputeStatus, default: DisputeStatus.Open })
  status: DisputeStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'assigned_admin_id' })
  assignedAdmin: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  assignedAdminId: string | null;

  @ManyToOne(() => Conversation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Relation<Conversation>;

  @Column(uuidRef())
  conversationId: string;

  @Column({ type: 'enum', enum: DisputeBookingOutcome, nullable: true })
  bookingOutcome: DisputeBookingOutcome | null;

  @Column({ type: 'text', nullable: true })
  decisionNote: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'resolved_by_id' })
  resolvedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  resolvedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date | null;
}

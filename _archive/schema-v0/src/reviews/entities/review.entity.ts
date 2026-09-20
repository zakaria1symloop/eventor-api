import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { ReviewStatus } from '../../common/enums/moderation.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Booking } from '../../bookings/entities/booking.entity.js';
import { Pack } from '../../packs/entities/pack.entity.js';
import { Service } from '../../services/entities/service.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('reviews')
@Index(['providerId', 'status'])
@Index(['serviceId', 'status'])
@Index(['status', 'createdAt'])
export class Review extends AbstractEntity {
  @ManyToOne(() => Booking, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef({ unique: true }))
  bookingId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_id' })
  author: Relation<User>;

  @Column(uuidRef())
  authorId: string;

  @ManyToOne(() => Service, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service> | null;

  @Column(uuidRef({ nullable: true }))
  serviceId: string | null;

  @ManyToOne(() => Pack, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pack_id' })
  pack: Relation<Pack> | null;

  @Column(uuidRef({ nullable: true }))
  packId: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider: Relation<User>;

  @Column(uuidRef())
  providerId: string;

  /** 1–5. */
  @Column({ type: 'tinyint', unsigned: true })
  rating: number;

  @Column({ type: 'text' })
  comment: string;

  @Column({ type: 'enum', enum: ReviewStatus, default: ReviewStatus.Published })
  status: ReviewStatus;

  @Column({ type: 'text', nullable: true })
  redactedComment: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'moderated_by_id' })
  moderatedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  moderatedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  moderatedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  moderationNote: string | null;

  /** e.g. `["phone"]`. */
  @Column({ type: 'json', nullable: true })
  detectedFlags: string[] | null;
}

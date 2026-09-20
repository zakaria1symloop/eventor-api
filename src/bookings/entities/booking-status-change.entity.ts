import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { BookingStatus } from '../../common/enums/booking.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Booking } from './booking.entity.js';

@Entity('booking_status_changes')
export class BookingStatusChange extends AppendOnlyEntity {
  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef())
  bookingId: string;

  @Column({ type: 'enum', enum: BookingStatus, nullable: true })
  fromStatus: BookingStatus | null;

  @Column({ type: 'enum', enum: BookingStatus })
  toStatus: BookingStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_id' })
  actor: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  actorId: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  reason: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'boolean', default: false })
  notified: boolean;
}

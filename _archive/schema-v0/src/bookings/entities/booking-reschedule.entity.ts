import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { RescheduleStatus } from '../../common/enums/booking.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Booking } from './booking.entity.js';

@Entity('booking_reschedules')
export class BookingReschedule extends AbstractEntity {
  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef())
  bookingId: string;

  @Column({ type: 'date' })
  oldDate: string;

  @Column({ type: 'time', nullable: true })
  oldStart: string | null;

  @Column({ type: 'time', nullable: true })
  oldEnd: string | null;

  @Column({ type: 'date' })
  newDate: string;

  @Column({ type: 'time', nullable: true })
  newStart: string | null;

  @Column({ type: 'time', nullable: true })
  newEnd: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'proposed_by_id' })
  proposedBy: Relation<User>;

  @Column(uuidRef())
  proposedById: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason: string | null;

  @Column({ type: 'boolean', default: false })
  forced: boolean;

  @Column({ type: 'enum', enum: RescheduleStatus, default: RescheduleStatus.Pending })
  status: RescheduleStatus;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date | null;
}

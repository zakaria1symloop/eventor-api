import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Booking } from './booking.entity.js';

@Entity('booking_price_changes')
export class BookingPriceChange extends AppendOnlyEntity {
  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef())
  bookingId: string;

  @Column(money())
  oldTotal: string;

  @Column(money())
  newTotal: string;

  @Column({ type: 'json' })
  linesBefore: unknown;

  @Column({ type: 'json' })
  linesAfter: unknown;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_id' })
  actor: Relation<User>;

  @Column(uuidRef())
  actorId: string;
}

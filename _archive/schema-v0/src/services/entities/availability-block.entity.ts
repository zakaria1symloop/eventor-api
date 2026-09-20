import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AvailabilityKind } from '../../common/enums/service.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Booking } from '../../bookings/entities/booking.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { Service } from './service.entity.js';

/** A day or slot a provider cannot take. */
@Entity('availability_blocks')
@Index(['providerId', 'date'])
export class AvailabilityBlock extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider: Relation<User>;

  @Column(uuidRef())
  providerId: string;

  /** Null = the whole provider. */
  @ManyToOne(() => Service, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service> | null;

  @Column(uuidRef({ nullable: true }))
  serviceId: string | null;

  @Column({ type: 'date' })
  date: string;

  @Column({ type: 'time', nullable: true })
  startTime: string | null;

  @Column({ type: 'time', nullable: true })
  endTime: string | null;

  @Column({ type: 'enum', enum: AvailabilityKind })
  kind: AvailabilityKind;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking> | null;

  @Column(uuidRef({ nullable: true }))
  bookingId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;
}

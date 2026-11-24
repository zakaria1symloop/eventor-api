import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { BookingLineKind } from '../../common/enums/booking.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef } from '../../database/columns.js';
import { Service } from '../../services/entities/service.entity.js';
import { Booking } from './booking.entity.js';

@Entity('booking_lines')
export class BookingLine extends AbstractEntity {
  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking>;

  @Column(uuidRef())
  bookingId: string;

  @Column({ type: 'enum', enum: BookingLineKind })
  kind: BookingLineKind;

  @ManyToOne(() => Service, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service> | null;

  @Column(uuidRef({ nullable: true }))
  serviceId: string | null;

  @Column({ type: 'varchar', length: 190 })
  label: string;

  /** BUG-O2: the Arabic label (service / extra / pack name in Arabic); null = none, the English one is shown. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  labelAr: string | null;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column(money())
  unitAmount: string;

  @Column(money())
  amount: string;

  @Column({ type: 'int', default: 0 })
  position: number;
}

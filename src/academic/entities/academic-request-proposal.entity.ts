import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Booking } from '../../bookings/entities/booking.entity.js';
import { Service } from '../../services/entities/service.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { AcademicRequest } from './academic-request.entity.js';

/** A service the admin proposes for a request. */
@Entity('academic_request_proposals')
@Unique(['requestId', 'serviceId'])
export class AcademicRequestProposal extends AbstractEntity {
  @ManyToOne(() => AcademicRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request: Relation<AcademicRequest>;

  @Column(uuidRef())
  requestId: string;

  @ManyToOne(() => Service, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @Column(uuidRef())
  serviceId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'proposed_by_id' })
  proposedBy: Relation<User>;

  @Column(uuidRef())
  proposedById: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking> | null;

  @Column(uuidRef({ nullable: true }))
  bookingId: string | null;
}

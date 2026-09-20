import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import {
  ClosedScope,
  ConversationKind,
  ConversationStatus,
} from '../../common/enums/moderation.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { AcademicRequest } from '../../academic/entities/academic-request.entity.js';
import { Booking } from '../../bookings/entities/booking.entity.js';
import { Service } from '../../services/entities/service.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('conversations')
export class Conversation extends AbstractEntity {
  @Column({ type: 'enum', enum: ConversationKind })
  kind: ConversationKind;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'booking_id' })
  booking: Relation<Booking> | null;

  @Column(uuidRef({ nullable: true }))
  bookingId: string | null;

  @ManyToOne(() => Service, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service> | null;

  @Column(uuidRef({ nullable: true }))
  serviceId: string | null;

  @ManyToOne(() => AcademicRequest, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'academic_request_id' })
  academicRequest: Relation<AcademicRequest> | null;

  @Column(uuidRef({ nullable: true }))
  academicRequestId: string | null;

  @Column({ type: 'enum', enum: ConversationStatus, default: ConversationStatus.Open })
  status: ConversationStatus;

  @Column({ type: 'enum', enum: ClosedScope, nullable: true })
  closedScope: ClosedScope | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  closedReason: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'closed_by_id' })
  closedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  closedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  closedAt: Date | null;

  /** Null until the first message. */
  @Column({ type: 'datetime', nullable: true })
  lastMessageAt: Date | null;
}

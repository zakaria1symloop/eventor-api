import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import {
  BookingSource,
  BookingStatus,
  CancelledBy,
} from '../../common/enums/booking.enums.js';
import { EventType } from '../../common/enums/catalog.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef, wilayaRef } from '../../database/columns.js';
import { AcademicRequest } from '../../academic/entities/academic-request.entity.js';
import { Commune } from '../../catalog/entities/commune.entity.js';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { Pack } from '../../packs/entities/pack.entity.js';
import { Service } from '../../services/entities/service.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('bookings')
@Index(['status', 'eventDate'])
@Index(['providerId', 'status'])
@Index(['clientId', 'createdAt'])
@Index(['serviceId'])
@Index(['packId'])
@Index(['status', 'respondedAt', 'createdAt'])
export class Booking extends AbstractEntity {
  /** EVT-000123. */
  @Column({ type: 'varchar', length: 12, unique: true })
  reference: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'client_id' })
  client: Relation<User>;

  @Column(uuidRef())
  clientId: string;

  /** Lead provider for packs. */
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider: Relation<User>;

  @Column(uuidRef())
  providerId: string;

  /** Exactly one of service / pack is set. */
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

  @ManyToOne(() => AcademicRequest, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'academic_request_id' })
  academicRequest: Relation<AcademicRequest> | null;

  @Column(uuidRef({ nullable: true }))
  academicRequestId: string | null;

  @Column({ type: 'enum', enum: BookingStatus, default: BookingStatus.Pending })
  status: BookingStatus;

  @Column({ type: 'enum', enum: EventType })
  eventType: EventType;

  @Column({ type: 'date' })
  eventDate: string;

  @Column({ type: 'time', nullable: true })
  startTime: string | null;

  @Column({ type: 'time', nullable: true })
  endTime: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  locationText: string | null;

  @ManyToOne(() => Commune, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'commune_id' })
  commune: Relation<Commune> | null;

  @Column(uuidRef({ nullable: true }))
  communeId: string | null;

  @ManyToOne(() => Wilaya, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya>;

  @Column(wilayaRef())
  wilayaCode: number;

  @Column({ type: 'int', nullable: true })
  guests: number | null;

  @Column({ type: 'text', nullable: true })
  clientNote: string | null;

  @Column(money())
  subtotal: string;

  @Column(money())
  discountTotal: string;

  @Column(money())
  total: string;

  /** Snapshot of `platform_fee_percent` at creation. */
  @Column({ type: 'decimal', precision: 5, scale: 2 })
  feePercent: string;

  @Column({ type: 'datetime', nullable: true })
  respondedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  reminderSentAt: Date | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  declineReason: string | null;

  @Column({ type: 'enum', enum: CancelledBy, nullable: true })
  cancelledBy: CancelledBy | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  cancelReason: string | null;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  reviewRequestedAt: Date | null;

  @Column({ type: 'enum', enum: BookingSource })
  source: BookingSource;
}

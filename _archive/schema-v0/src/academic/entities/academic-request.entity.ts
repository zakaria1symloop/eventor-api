import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AcademicRequestStatus } from '../../common/enums/booking.enums.js';
import { EventType } from '../../common/enums/catalog.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef, wilayaRef } from '../../database/columns.js';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('academic_requests')
export class AcademicRequest extends AbstractEntity {
  /** ACR-000142. */
  @Column({ type: 'varchar', length: 12, unique: true })
  reference: string;

  /** The academic user. */
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'institution_id' })
  institution: Relation<User>;

  @Column(uuidRef())
  institutionId: string;

  @Column({ type: 'varchar', length: 190 })
  title: string;

  @Column({ type: 'enum', enum: EventType })
  eventType: EventType;

  @Column({ type: 'date' })
  eventDate: string;

  @Column({ type: 'time', nullable: true })
  startTime: string | null;

  @Column({ type: 'time', nullable: true })
  endTime: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  venue: string | null;

  @ManyToOne(() => Wilaya, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya>;

  @Column(wilayaRef())
  wilayaCode: number;

  @Column({ type: 'int' })
  attendees: number;

  @Column({ type: 'int', nullable: true })
  guests: number | null;

  @Column(money({ nullable: true }))
  budgetMin: string | null;

  @Column(money({ nullable: true }))
  budgetMax: string | null;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 190, nullable: true })
  sponsor: string | null;

  @Column({ type: 'varchar', length: 120 })
  contactName: string;

  @Column({ type: 'varchar', length: 20 })
  contactPhone: string;

  @Column({
    type: 'enum',
    enum: AcademicRequestStatus,
    default: AcademicRequestStatus.Draft,
  })
  status: AcademicRequestStatus;

  /** Fields to change, e.g. `["budget","attachments"]`. */
  @Column({ type: 'json', nullable: true })
  requestedChanges: string[] | null;

  @Column({ type: 'text', nullable: true })
  decisionMessage: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  rejectReason: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'decided_by_id' })
  decidedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  decidedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  decidedAt: Date | null;

  /** Approved while the institution was unverified. */
  @Column({ type: 'boolean', default: false })
  approvedWithOverride: boolean;

  @Column({ type: 'datetime', nullable: true })
  submittedAt: Date | null;
}

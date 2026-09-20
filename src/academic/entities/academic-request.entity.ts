import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AcademicRequestStatus } from '../../common/enums/academic.enums.js';
import { EventType } from '../../common/enums/catalog.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { money, uuidRef, wilayaRef } from '../../database/columns.js';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { FormVersion } from './form-version.entity.js';
import { Form } from './form.entity.js';

@Entity('academic_requests')
@Index(['status', 'submittedAt'])
@Index(['formId'])
@Index(['requesterEmail'])
@Index(['eventDate'])
export class AcademicRequest extends AbstractEntity {
  /** ACR-000142 */
  @Column({ type: 'varchar', length: 12, unique: true })
  reference: string;

  @ManyToOne(() => Form, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'form_id' })
  form: Relation<Form>;

  @Column(uuidRef())
  formId: string;

  @ManyToOne(() => FormVersion, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'form_version_id' })
  formVersion: Relation<FormVersion>;

  @Column(uuidRef())
  formVersionId: string;

  @Column({ type: 'json' })
  answers: Record<string, unknown>;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requester_id' })
  requester: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  requesterId: string | null;

  @Column({ type: 'varchar', length: 120 })
  requesterName: string;

  @Column({ type: 'varchar', length: 190 })
  requesterEmail: string;

  @Column({ type: 'varchar', length: 20 })
  requesterPhone: string;

  @Column({ type: 'varchar', length: 190, nullable: true })
  institutionName: string | null;

  @Column({ type: 'varchar', length: 190 })
  title: string;

  @Column({ type: 'enum', enum: EventType, nullable: true })
  eventType: EventType | null;

  @Column({ type: 'date', nullable: true })
  eventDate: string | null;

  @ManyToOne(() => Wilaya, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya> | null;

  @Column(wilayaRef({ nullable: true }))
  wilayaCode: number | null;

  @Column({ type: 'int', nullable: true })
  attendees: number | null;

  @Column(money({ nullable: true }))
  budgetMin: string | null;

  @Column(money({ nullable: true }))
  budgetMax: string | null;

  @Column({
    type: 'enum',
    enum: AcademicRequestStatus,
    default: AcademicRequestStatus.Pending,
  })
  status: AcademicRequestStatus;

  @Column({ type: 'json', nullable: true })
  requestedChanges: Record<string, unknown> | null;

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

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'assigned_admin_id' })
  assignedAdmin: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  assignedAdminId: string | null;

  @Column({ type: 'datetime' })
  submittedAt: Date;
}

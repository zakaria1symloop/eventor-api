import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { FormStatus } from '../../common/enums/academic.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { FormVersion, type FormSchema } from './form-version.entity.js';

@Entity('forms')
export class Form extends AbstractEntity {
  @Column({ type: 'varchar', length: 80, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 160 })
  nameEn: string;

  @Column({ type: 'varchar', length: 160 })
  nameAr: string;

  @Column({ type: 'text', nullable: true })
  descriptionEn: string | null;

  @Column({ type: 'text', nullable: true })
  descriptionAr: string | null;

  @Column({ type: 'enum', enum: FormStatus, default: FormStatus.Draft })
  status: FormStatus;

  /** Exactly one form is the default (checked by the API). */
  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'boolean', default: false })
  requiresAuth: boolean;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  maxSubmissionsPerEmailPerMonth: number | null;

  @Column({ type: 'text' })
  confirmationEn: string;

  @Column({ type: 'text' })
  confirmationAr: string;

  @ManyToOne(() => FormVersion, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'live_version_id' })
  liveVersion: Relation<FormVersion> | null;

  @Column(uuidRef({ nullable: true }))
  liveVersionId: string | null;

  @Column({ type: 'json', nullable: true })
  draftSchema: FormSchema | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: Relation<User>;

  @Column(uuidRef())
  createdById: string;
}

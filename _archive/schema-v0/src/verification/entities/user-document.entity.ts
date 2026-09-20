import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import {
  DocumentRejectReason,
  DocumentStatus,
  DocumentType,
} from '../../common/enums/file.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { User } from '../../users/entities/user.entity.js';

/** One row per submitted file version of a verification document. */
@Entity('user_documents')
@Index(['userId', 'type', 'isCurrent'])
@Index(['status', 'createdAt'])
export class UserDocument extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @Column({ type: 'enum', enum: DocumentType })
  type: DocumentType;

  @ManyToOne(() => StoredFile, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile>;

  @Column(uuidRef())
  fileId: string;

  @Column({ type: 'enum', enum: DocumentStatus, default: DocumentStatus.Pending })
  status: DocumentStatus;

  /** False for older versions after a resubmission. */
  @Column({ type: 'boolean', default: true })
  isCurrent: boolean;

  @Column({ type: 'enum', enum: DocumentRejectReason, nullable: true })
  rejectReason: DocumentRejectReason | null;

  @Column({ type: 'text', nullable: true })
  rejectNote: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reviewed_by_id' })
  reviewedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  reviewedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  reviewedAt: Date | null;
}

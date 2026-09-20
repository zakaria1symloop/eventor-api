import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { DisputeEvidenceKind } from '../../common/enums/moderation.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { Dispute } from './dispute.entity.js';

@Entity('dispute_evidence')
export class DisputeEvidence extends AppendOnlyEntity {
  @ManyToOne(() => Dispute, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dispute_id' })
  dispute: Relation<Dispute>;

  @Column(uuidRef())
  disputeId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uploaded_by_id' })
  uploadedBy: Relation<User>;

  @Column(uuidRef())
  uploadedById: string;

  @ManyToOne(() => StoredFile, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile> | null;

  @Column(uuidRef({ nullable: true }))
  fileId: string | null;

  @Column({ type: 'enum', enum: DisputeEvidenceKind })
  kind: DisputeEvidenceKind;

  @Column({ type: 'text', nullable: true })
  note: string | null;
}

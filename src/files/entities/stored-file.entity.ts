import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { FilePurpose, FileProcessingStatus } from '../../common/enums/file.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Table `files`. Named StoredFile to avoid clashing with the DOM/Node `File` global. */
@Entity('files')
export class StoredFile extends AbstractEntity {
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  ownerId: string | null;

  @Column({ type: 'enum', enum: FilePurpose })
  purpose: FilePurpose;

  /** Relative to STORAGE_ROOT; the served (compressed) file. Never exposed. */
  @Column({ type: 'varchar', length: 255 })
  storagePath: string;

  @Column({ type: 'varchar', length: 255 })
  originalName: string;

  @Column({ type: 'varchar', length: 100 })
  mimeType: string;

  @Column({ type: 'int', unsigned: true })
  sizeBytes: number;

  @Column({ type: 'int', unsigned: true, nullable: true })
  originalSizeBytes: number | null;

  @Column({ type: 'int', unsigned: true, nullable: true })
  width: number | null;

  @Column({ type: 'int', unsigned: true, nullable: true })
  height: number | null;

  @Column({
    type: 'enum',
    enum: FileProcessingStatus,
    default: FileProcessingStatus.Ready,
  })
  processingStatus: FileProcessingStatus;

  @Column({ type: 'char', length: 64 })
  checksum: string;

  @Column({ type: 'boolean' })
  isPrivate: boolean;
}

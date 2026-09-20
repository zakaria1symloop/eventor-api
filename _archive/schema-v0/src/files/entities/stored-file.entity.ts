import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { FileProcessingStatus, FilePurpose } from '../../common/enums/file.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Every uploaded binary (table `files`; the class avoids the global `File`). */
@Entity('files')
export class StoredFile extends AbstractEntity {
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  ownerId: string | null;

  @Column({ type: 'enum', enum: FilePurpose })
  purpose: FilePurpose;

  @Column({ type: 'varchar', length: 500 })
  storagePath: string;

  @Column({ type: 'varchar', length: 255 })
  originalName: string;

  @Column({ type: 'varchar', length: 120 })
  mimeType: string;

  /** Stored (compressed) size. */
  @Column({ type: 'int', unsigned: true })
  sizeBytes: number;

  /** Size before compression. */
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

  /** SHA-256 hex. */
  @Column({ type: 'char', length: 64 })
  checksum: string;
}

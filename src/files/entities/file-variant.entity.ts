import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { FileVariantKind } from '../../common/enums/file.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from './stored-file.entity.js';

@Entity('file_variants')
@Unique(['fileId', 'variant'])
export class FileVariant extends AppendOnlyEntity {
  @ManyToOne(() => StoredFile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile>;

  @Column(uuidRef())
  fileId: string;

  @Column({ type: 'enum', enum: FileVariantKind })
  variant: FileVariantKind;

  @Column({ type: 'varchar', length: 255 })
  storagePath: string;

  @Column({ type: 'varchar', length: 100 })
  mimeType: string;

  @Column({ type: 'int', unsigned: true })
  width: number;

  @Column({ type: 'int', unsigned: true })
  height: number;

  @Column({ type: 'int', unsigned: true })
  sizeBytes: number;
}

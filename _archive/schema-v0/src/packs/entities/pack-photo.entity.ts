import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { Pack } from './pack.entity.js';

@Entity('pack_photos')
export class PackPhoto extends AppendOnlyEntity {
  @ManyToOne(() => Pack, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pack_id' })
  pack: Relation<Pack>;

  @Column(uuidRef())
  packId: string;

  @ManyToOne(() => StoredFile, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile>;

  @Column(uuidRef())
  fileId: string;

  /** 0 = cover. */
  @Column({ type: 'int', default: 0 })
  position: number;
}

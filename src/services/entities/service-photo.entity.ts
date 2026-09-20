import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { Service } from './service.entity.js';

@Entity('service_photos')
export class ServicePhoto extends AppendOnlyEntity {
  @ManyToOne(() => Service, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service>;

  @Column(uuidRef())
  serviceId: string;

  @ManyToOne(() => StoredFile, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile>;

  @Column(uuidRef())
  fileId: string;

  /** 0 = cover. */
  @Column({ type: 'int', default: 0 })
  position: number;
}

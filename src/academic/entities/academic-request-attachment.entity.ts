import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { AcademicRequest } from './academic-request.entity.js';

@Entity('academic_request_attachments')
export class AcademicRequestAttachment extends AppendOnlyEntity {
  @ManyToOne(() => AcademicRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request: Relation<AcademicRequest>;

  @Column(uuidRef())
  requestId: string;

  @ManyToOne(() => StoredFile, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile>;

  @Column(uuidRef())
  fileId: string;

  @Column({ type: 'varchar', length: 60 })
  fieldKey: string;
}

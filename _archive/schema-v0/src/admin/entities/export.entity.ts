import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { ExportFormat, ExportStatus } from '../../common/enums/admin.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('exports')
export class Export extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requested_by_id' })
  requestedBy: Relation<User>;

  @Column(uuidRef())
  requestedById: string;

  @Column({ type: 'varchar', length: 40 })
  resource: string;

  @Column({ type: 'json' })
  filters: Record<string, unknown>;

  @Column({ type: 'json' })
  columns: string[];

  @Column({ type: 'enum', enum: ExportFormat })
  format: ExportFormat;

  @Column({ type: 'enum', enum: ExportStatus, default: ExportStatus.Queued })
  status: ExportStatus;

  @Column({ type: 'int', nullable: true })
  rowCount: number | null;

  @ManyToOne(() => StoredFile, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile> | null;

  @Column(uuidRef({ nullable: true }))
  fileId: string | null;

  @Column({ type: 'datetime', nullable: true })
  emailedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}

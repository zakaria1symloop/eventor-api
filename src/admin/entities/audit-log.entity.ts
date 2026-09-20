import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AuditLevel, AuditSource } from '../../common/enums/admin.enums.js';
import { UserRole } from '../../common/enums/user.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('audit_logs')
@Index(['objectType', 'objectId', 'createdAt'])
@Index(['actorId', 'createdAt'])
@Index(['level', 'createdAt'])
@Index(['createdAt'])
export class AuditLog extends AppendOnlyEntity {
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_id' })
  actor: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  actorId: string | null;

  @Column({ type: 'enum', enum: UserRole, nullable: true })
  actorRole: UserRole | null;

  @Column({ type: 'varchar', length: 60 })
  action: string;

  @Column({ type: 'varchar', length: 40 })
  objectType: string;

  @Column({ type: 'char', length: 36, nullable: true })
  objectId: string | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  objectLabel: string | null;

  @Column({ type: 'enum', enum: AuditLevel })
  level: AuditLevel;

  @Column({ type: 'json', nullable: true })
  changes: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'enum', enum: AuditSource })
  source: AuditSource;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestId: string | null;
}

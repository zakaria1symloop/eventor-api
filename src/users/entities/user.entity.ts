import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import {
  Language,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '../../common/enums/user.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef, wilayaRef } from '../../database/columns.js';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';

@Entity('users')
@Index(['role', 'status'])
@Index(['verificationStatus'])
@Index(['createdAt'])
@Index(['fullName', 'email'], { fulltext: true })
export class User extends AbstractEntity {
  /** Immutable. */
  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.Active })
  status: UserStatus;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.NotRequired,
  })
  verificationStatus: VerificationStatus;

  @Column({ type: 'varchar', length: 120 })
  fullName: string;

  @Column({ type: 'varchar', length: 190, unique: true })
  email: string;

  @Column({ type: 'datetime', nullable: true })
  emailVerifiedAt: Date | null;

  /** `+213…` */
  @Column({ type: 'varchar', length: 20, unique: true, nullable: true })
  phone: string | null;

  /** argon2id; null for invited admins until they accept. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  passwordHash: string | null;

  @ManyToOne(() => StoredFile, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'avatar_file_id' })
  avatarFile: Relation<StoredFile> | null;

  @Column(uuidRef({ nullable: true }))
  avatarFileId: string | null;

  @Column({ type: 'enum', enum: Language, default: Language.Ar })
  language: Language;

  @ManyToOne(() => Wilaya, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya> | null;

  @Column(wilayaRef({ nullable: true }))
  wilayaCode: number | null;

  @Column({ type: 'datetime', nullable: true })
  lastActiveAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  blockedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  blockedUntil: Date | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  blockedReason: string | null;

  @Column({ type: 'text', nullable: true })
  blockedMessage: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'blocked_by_id' })
  blockedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  blockedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  anonymisedAt: Date | null;
}

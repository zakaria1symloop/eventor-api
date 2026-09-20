import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('admin_invitations')
export class AdminInvitation extends AbstractEntity {
  @Column({ type: 'varchar', length: 190 })
  email: string;

  @Column({ type: 'varchar', length: 120 })
  fullName: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  tokenHash: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'invited_by_id' })
  invitedBy: Relation<User>;

  @Column(uuidRef())
  invitedById: string;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  @Column({ type: 'datetime', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  revokedAt: Date | null;

  /** Set when the invitation is accepted. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  userId: string | null;
}

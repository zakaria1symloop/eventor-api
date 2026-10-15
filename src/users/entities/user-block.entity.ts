import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { uuidRef } from '../../database/columns.js';
import { User } from './user.entity.js';

/**
 * A client or provider blocked another one (store guideline: users must be able
 * to block abusive users). Either direction stops chat and new booking requests
 * between the two. Unblocking deletes the row, so there is no soft delete.
 */
@Entity('user_blocks')
@Index('IDX_user_blocks_pair', ['blockerId', 'blockedId'], { unique: true })
@Index('IDX_user_blocks_blocked', ['blockedId'])
export class UserBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blocker_id', foreignKeyConstraintName: 'FK_user_blocks_blocker' })
  blocker: Relation<User>;

  @Column(uuidRef())
  blockerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blocked_id', foreignKeyConstraintName: 'FK_user_blocks_blocked' })
  blocked: Relation<User>;

  @Column(uuidRef())
  blockedId: string;
}

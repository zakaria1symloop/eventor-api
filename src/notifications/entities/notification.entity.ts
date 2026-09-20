import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('notifications')
@Index(['userId', 'readAt', 'createdAt'])
export class Notification extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @Column({ type: 'varchar', length: 60 })
  type: string;

  @Column({ type: 'varchar', length: 190 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'json', nullable: true })
  data: Record<string, unknown> | null;

  @Column({ type: 'datetime', nullable: true })
  readAt: Date | null;
}

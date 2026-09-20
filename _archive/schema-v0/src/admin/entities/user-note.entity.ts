import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Internal admin note about a user. */
@Entity('user_notes')
export class UserNote extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_id' })
  author: Relation<User>;

  @Column(uuidRef())
  authorId: string;

  @Column({ type: 'text' })
  body: string;
}

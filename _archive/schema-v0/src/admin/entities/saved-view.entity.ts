import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('saved_views')
export class SavedView extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner: Relation<User>;

  @Column(uuidRef())
  ownerId: string;

  /** `users`, `services`, … */
  @Column({ type: 'varchar', length: 40 })
  resource: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'json' })
  query: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  isShared: boolean;
}

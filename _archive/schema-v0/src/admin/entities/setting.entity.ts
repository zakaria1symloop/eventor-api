import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Platform settings key/value; every change is audited. */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  key: string;

  @Column({ type: 'json' })
  value: unknown;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'updated_by_id' })
  updatedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  updatedById: string | null;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

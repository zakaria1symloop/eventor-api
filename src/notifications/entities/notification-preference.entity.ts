import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { User } from '../../users/entities/user.entity.js';

@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column({ type: 'boolean', default: true })
  pushBookings: boolean;

  @Column({ type: 'boolean', default: true })
  pushMessages: boolean;

  @Column({ type: 'boolean', default: true })
  pushReviews: boolean;

  @Column({ type: 'boolean', default: true })
  emailBookings: boolean;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

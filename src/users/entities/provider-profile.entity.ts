import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  type Relation,
} from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { counter, rating, uuidRef } from '../../database/columns.js';
import { Category } from '../../catalog/entities/category.entity.js';
import { User } from './user.entity.js';

/** 1:1 with provider users. */
@Entity('provider_profiles')
export class ProviderProfile extends AbstractEntity {
  @OneToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef({ unique: true }))
  userId: string;

  @Column({ type: 'varchar', length: 150 })
  businessName: string;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Relation<Category>;

  @Column(uuidRef())
  categoryId: string;

  @Column({ type: 'text', nullable: true })
  bioEn: string | null;

  @Column({ type: 'text', nullable: true })
  bioAr: string | null;

  @Column({ type: 'json', nullable: true })
  languagesSpoken: string[] | null;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  yearsActive: number | null;

  @Column({ type: 'boolean', default: true })
  acceptingBookings: boolean;

  @Column(rating())
  avgRating: string;

  @Column(counter())
  ratingCount: number;

  @Column(counter())
  completedBookingsCount: number;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  replyRate: number | null;

  @Column({ type: 'int', nullable: true })
  avgReplyMinutes: number | null;
}

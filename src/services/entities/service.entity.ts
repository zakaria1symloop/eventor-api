import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { PriceType, ServiceStatus } from '../../common/enums/catalog.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { counter, money, rating, uuidRef } from '../../database/columns.js';
import { Category } from '../../catalog/entities/category.entity.js';
import { User } from '../../users/entities/user.entity.js';

export interface ServiceFact {
  label_en: string;
  label_ar: string;
  value_en: string;
  value_ar: string;
}

@Entity('services')
@Index(['status', 'categoryId'])
@Index(['providerId', 'status'])
@Index(['isFeatured', 'featuredPosition'])
@Index(['titleEn', 'titleAr'], { fulltext: true })
@Index(['createdAt'])
export class Service extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'provider_id' })
  provider: Relation<User>;

  @Column(uuidRef())
  providerId: string;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Relation<Category>;

  @Column(uuidRef())
  categoryId: string;

  @Column({ type: 'varchar', length: 160 })
  titleEn: string;

  @Column({ type: 'varchar', length: 160 })
  titleAr: string;

  @Column({ type: 'text' })
  descriptionEn: string;

  @Column({ type: 'text' })
  descriptionAr: string;

  /** Provider's own policy text; shown, never enforced. */
  @Column({ type: 'text', nullable: true })
  cancellationPolicyEn: string | null;

  @Column({ type: 'text', nullable: true })
  cancellationPolicyAr: string | null;

  @Column({ type: 'json', nullable: true })
  facts: ServiceFact[] | null;

  @Column(money())
  basePrice: string;

  @Column({ type: 'enum', enum: PriceType })
  priceType: PriceType;

  /** 1 = "Only one booking per day" (the provider's checkbox); null = no daily limit. */
  @Column({ type: 'tinyint', unsigned: true, nullable: true, default: 1 })
  maxEventsPerDay: number | null;

  @Column({ type: 'int', nullable: true })
  maxGuests: number | null;

  /**
   * Different clients who may book overlapping hours: 1 = one at a time (default); null = the
   * provider's checkbox "Allow several clients at the same time" (no limit). Timed bookings only.
   */
  @Column({ type: 'tinyint', unsigned: true, nullable: true, default: 1 })
  concurrentClients: number | null;

  /** Event dates the service can be booked for (inclusive); null = no limit. Hidden from the catalog after `availableUntil`. */
  @Column({ type: 'date', nullable: true })
  availableFrom: string | null;

  @Column({ type: 'date', nullable: true })
  availableUntil: string | null;

  @Column({ type: 'enum', enum: ServiceStatus, default: ServiceStatus.Draft })
  status: ServiceStatus;

  @Column({ type: 'varchar', length: 60, nullable: true })
  hiddenReason: string | null;

  @Column({ type: 'text', nullable: true })
  hiddenNote: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'hidden_by_id' })
  hiddenBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  hiddenById: string | null;

  @Column({ type: 'datetime', nullable: true })
  hiddenAt: Date | null;

  @Column({ type: 'boolean', default: true })
  allowResubmit: boolean;

  @Column({ type: 'boolean', default: false })
  isFeatured: boolean;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  featuredPosition: number | null;

  @Column(rating())
  avgRating: string;

  @Column(counter())
  ratingCount: number;

  @Column(counter())
  bookingsCount: number;

  @Column(counter())
  favouritesCount: number;
}

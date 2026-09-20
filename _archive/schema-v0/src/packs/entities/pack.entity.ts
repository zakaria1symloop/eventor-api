import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { EventType } from '../../common/enums/catalog.enums.js';
import { PackStatus } from '../../common/enums/service.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { counter, money, rating, uuidRef, wilayaRef } from '../../database/columns.js';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('packs')
export class Pack extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'lead_provider_id' })
  leadProvider: Relation<User>;

  @Column(uuidRef())
  leadProviderId: string;

  @Column({ type: 'varchar', length: 160 })
  nameEn: string;

  @Column({ type: 'varchar', length: 160 })
  nameAr: string;

  @Column({ type: 'text' })
  descriptionEn: string;

  @Column({ type: 'text' })
  descriptionAr: string;

  @Column({ type: 'enum', enum: EventType })
  eventType: EventType;

  @ManyToOne(() => Wilaya, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya>;

  @Column(wilayaRef())
  wilayaCode: number;

  @Column(money())
  price: string;

  @Column({ type: 'int', nullable: true })
  maxGuests: number | null;

  @Column({ type: 'enum', enum: PackStatus, default: PackStatus.Draft })
  status: PackStatus;

  /** Recomputed when an item's service is hidden/deleted or its provider blocked. */
  @Column({ type: 'boolean', default: false })
  needsAttention: boolean;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'created_by_id' })
  createdBy: Relation<User>;

  @Column(uuidRef())
  createdById: string;

  @Column(rating())
  avgRating: string;

  @Column(counter())
  ratingCount: number;

  @Column(counter())
  bookingsCount: number;
}

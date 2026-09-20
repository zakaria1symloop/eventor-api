import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { Wilaya } from '../../catalog/entities/wilaya.entity.js';
import { ProviderProfile } from './provider-profile.entity.js';

/** Append-only join: the provider's default area. */
@Entity('provider_wilayas')
export class ProviderWilaya {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  providerProfileId: string;

  @PrimaryColumn({ type: 'tinyint', unsigned: true })
  wilayaCode: number;

  @ManyToOne(() => ProviderProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'provider_profile_id' })
  providerProfile: Relation<ProviderProfile>;

  @ManyToOne(() => Wilaya, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'wilaya_code' })
  wilaya: Relation<Wilaya>;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}

import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { Pack } from '../../packs/entities/pack.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { Service } from './service.entity.js';

/** Written by the future mobile API. */
@Entity('favourites')
@Unique(['userId', 'serviceId'])
@Unique(['userId', 'packId'])
export class Favourite extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @ManyToOne(() => Service, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service: Relation<Service> | null;

  @Column(uuidRef({ nullable: true }))
  serviceId: string | null;

  @ManyToOne(() => Pack, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pack_id' })
  pack: Relation<Pack> | null;

  @Column(uuidRef({ nullable: true }))
  packId: string | null;
}

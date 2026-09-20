import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { DevicePlatform } from '../../common/enums/messaging.enums.js';
import { AbstractEntity } from '../../database/abstract.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

/** Written by the future mobile API. */
@Entity('device_tokens')
export class DeviceToken extends AbstractEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  token: string;

  @Column({ type: 'enum', enum: DevicePlatform })
  platform: DevicePlatform;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt: Date | null;
}

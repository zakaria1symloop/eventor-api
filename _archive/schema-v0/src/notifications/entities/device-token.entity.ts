import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm';
import { Platform } from '../../common/enums/user.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';

@Entity('device_tokens')
export class DeviceToken extends AppendOnlyEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  token: string;

  @Column({ type: 'enum', enum: Platform })
  platform: Platform;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt: Date | null;
}

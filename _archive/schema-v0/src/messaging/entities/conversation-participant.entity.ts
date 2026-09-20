import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { ParticipantRole } from '../../common/enums/moderation.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Conversation } from './conversation.entity.js';

@Entity('conversation_participants')
@Unique(['conversationId', 'userId'])
export class ConversationParticipant extends AppendOnlyEntity {
  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Relation<Conversation>;

  @Column(uuidRef())
  conversationId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Column(uuidRef())
  userId: string;

  @Column({ type: 'enum', enum: ParticipantRole })
  role: ParticipantRole;

  @Column({ type: 'boolean', default: true })
  canWrite: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastReadAt: Date | null;
}

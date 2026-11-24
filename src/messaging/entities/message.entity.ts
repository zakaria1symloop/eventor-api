import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { MessageKind, MessageStatus } from '../../common/enums/messaging.enums.js';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { StoredFile } from '../../files/entities/stored-file.entity.js';
import { User } from '../../users/entities/user.entity.js';
import { Conversation } from './conversation.entity.js';

/** Append-only plus `updated_at` (moderation changes `status`; no soft delete). */
@Entity('messages')
@Index(['conversationId', 'createdAt'])
@Index(['body'], { fulltext: true })
export class Message extends AppendOnlyEntity {
  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Relation<Conversation>;

  @Column(uuidRef())
  conversationId: string;

  /** Null for system messages. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sender_id' })
  sender: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  senderId: string | null;

  @Column({ type: 'enum', enum: MessageKind })
  kind: MessageKind;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'text', nullable: true })
  bodyMasked: string | null;

  @ManyToOne(() => StoredFile, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file: Relation<StoredFile> | null;

  @Column(uuidRef({ nullable: true }))
  fileId: string | null;

  @Column({ type: 'enum', enum: MessageStatus, default: MessageStatus.Visible })
  status: MessageStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'moderated_by_id' })
  moderatedBy: Relation<User> | null;

  @Column(uuidRef({ nullable: true }))
  moderatedById: string | null;

  @Column({ type: 'datetime', nullable: true })
  moderatedAt: Date | null;

  /** BUG-G2: which booking event a system message reports (`system-messages.ts`); null for other messages. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  systemEvent: string | null;

  /** BUG-G2: `{ bookingId, bookingRef, params }` of that event. */
  @Column({ type: 'json', nullable: true })
  systemData: Record<string, unknown> | null;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

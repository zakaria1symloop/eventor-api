import { Column, Entity, JoinColumn, ManyToOne, Unique, type Relation } from 'typeorm';
import { AppendOnlyEntity } from '../../database/append-only.entity.js';
import { uuidRef } from '../../database/columns.js';
import { User } from '../../users/entities/user.entity.js';
import { Form } from './form.entity.js';

export type FormFieldType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'email'
  | 'phone'
  | 'single_choice'
  | 'multi_choice'
  | 'dropdown'
  | 'date'
  | 'time_range'
  | 'wilaya'
  | 'service_categories'
  | 'budget_range'
  | 'file'
  | 'section'
  | 'info'
  | 'consent';

export type FormMappableField =
  | 'title'
  | 'event_type'
  | 'event_date'
  | 'wilaya'
  | 'attendees'
  | 'institution_name'
  | 'needs'
  | 'budget'
  /** Extension: the requester's name and phone (status-rules §7 requires them; the email is the confirmed body email). */
  | 'requester_name'
  | 'requester_phone';

export interface FormField {
  key: string;
  type: FormFieldType;
  label_en: string;
  label_ar: string;
  help_en?: string;
  help_ar?: string;
  required?: boolean;
  options?: { value: string; label_en: string; label_ar: string }[];
  validation?: Record<string, unknown>;
  showIf?: Record<string, unknown>;
  section?: string;
  maps_to?: FormMappableField;
}

export interface FormSchema {
  fields: FormField[];
}

/** Append-only and immutable once published. */
@Entity('form_versions')
@Unique(['formId', 'version'])
export class FormVersion extends AppendOnlyEntity {
  @ManyToOne(() => Form, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'form_id' })
  form: Relation<Form>;

  @Column(uuidRef())
  formId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'json' })
  schema: FormSchema;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'published_by_id' })
  publishedBy: Relation<User>;

  @Column(uuidRef())
  publishedById: string;

  @Column({ type: 'datetime' })
  publishedAt: Date;
}

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Журнал действий (ТЗ 22.3): кто, когда, что изменил (до и после), IP, устройство.
 * Только дополняется: UPDATE/DELETE запрещены триггером и правами. Хранение — 3 года.
 */
@Entity('audit_log')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'entityType', 'entityId'])
@Index(['tenantId', 'important', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'uuid', nullable: true })
  membershipId: string | null;

  /** Например: settings.update, role.create, member.disable, document.unpost */
  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entityType: string | null;

  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  summary: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  /** Только изменившиеся поля: { field: [было, стало] } */
  @Column({ type: 'jsonb', nullable: true })
  diff: Record<string, [unknown, unknown]> | null;

  /** Важное действие — отдельный журнал (ТЗ 22.3) */
  @Column({ default: false })
  important: boolean;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 400, nullable: true })
  userAgent: string | null;

  @Column({ type: 'uuid', nullable: true })
  deviceId: string | null;

  /** Действие выполнено поддержкой платформы (ТЗ 24) */
  @Column({ type: 'uuid', nullable: true })
  supportSessionId: string | null;
}

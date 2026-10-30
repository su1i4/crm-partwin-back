import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Outbox (ТЗ 2.4.9): событие пишется в той же транзакции, что и изменение данных.
 * Обработчик раз в 1–2 с забирает новые события и рассылает (уведомления, WebSocket, Telegram, агрегаты).
 * Системная таблица без RLS: читает только фоновый обработчик.
 */
@Entity('outbox_events')
@Index('ix_outbox_pending', ['availableAt'], { where: 'processed_at IS NULL' })
export class OutboxEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** Например: settings.updated, notification.created, register.mode_changed */
  @Column({ type: 'varchar', length: 100 })
  type: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, any>;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  availableAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}

import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

/** Уведомление в системе (ТЗ 22.1): колокольчик, переход к объекту по клику. */
@Entity('notifications')
@Index(['tenantId', 'userId', 'readAt', 'createdAt'])
export class Notification extends TenantEntity {
  @Column({ type: 'uuid' })
  userId: string;

  /** Тип события: settings.changed, stock.below_min, request.new … */
  @Column({ type: 'varchar', length: 100 })
  type: string;

  @Column({ type: 'varchar', length: 300 })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entityType: string | null;

  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  /** Ссылка во фронтенде для перехода */
  @Column({ type: 'varchar', length: 300, nullable: true })
  link: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  data: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;
}

export interface NotificationChannels {
  inApp: boolean;
  telegram: boolean;
}

/** Каналы уведомлений пользователя по событиям (ТЗ 22.1). */
@Entity('notification_settings')
@Index('uq_notification_settings_user', ['tenantId', 'userId'], { unique: true })
export class NotificationSettings extends TenantEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  channels: Record<string, NotificationChannels>;
}

import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity } from '../../../database/tenant/base.entity';

/** Одноразовый код бота (ТЗ 22.2): привязка Telegram, сброс пароля, подтверждение передачи владения. */
@Entity('telegram_codes')
@Index(['codeHash'])
export class TelegramCode extends PlatformEntity {
  @Column({ type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 15 }) purpose: 'link' | 'reset' | 'ownership';
  @Column({ type: 'varchar', length: 64 }) codeHash: string;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) usedAt: Date | null;
  @Column({ type: 'smallint', default: 0 }) attempts: number;
  @Column({ type: 'jsonb', default: () => "'{}'" }) data: Record<string, unknown>;
}

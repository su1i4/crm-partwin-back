import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity } from '../../../database/tenant/base.entity';

/** Учётная запись — общая для всей платформы (ТЗ 3.2). Один человек — одна запись. */
@Entity('users')
@Index('uq_users_phone', ['phone'], { unique: true, where: 'phone IS NOT NULL' })
@Index('uq_users_email', ['email'], { unique: true, where: 'email IS NOT NULL' })
export class User extends PlatformEntity {
  /** Нормализованный телефон: 996555123456 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 100, select: false })
  passwordHash: string;

  /** ru | ky */
  @Column({ type: 'varchar', length: 5, default: 'ru' })
  locale: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 0 })
  failedLoginCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  /** Секрет TOTP, зашифрован (AES-GCM) */
  @Column({ type: 'varchar', length: 300, nullable: true, select: false })
  totpSecretEnc: string | null;

  @Column({ default: false })
  totpEnabled: boolean;

  /** Привязка Telegram (этап 7) */
  @Column({ type: 'bigint', nullable: true })
  telegramChatId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;
}

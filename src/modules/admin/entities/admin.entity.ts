import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PlatformEntity } from '../../../database/tenant/base.entity';

/** Сотрудник платформы (ТЗ 24): отдельная учётная запись, обязательная двухфакторная защита. */
@Entity('platform_admins')
@Index(['email'], { unique: true })
export class PlatformAdmin extends PlatformEntity {
  @Column({ type: 'varchar', length: 200 }) email: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 200, select: false }) passwordHash: string;
  @Column({ type: 'varchar', length: 300, select: false }) totpSecretEnc: string;
  /** admin — всё; support — магазины, вход поддержки, мониторинг */
  @Column({ type: 'varchar', length: 10, default: 'support' }) role: 'admin' | 'support';
  @Column({ default: true }) isActive: boolean;
  @Column({ type: 'int', default: 0 }) failedLogins: number;
  @Column({ type: 'timestamptz', nullable: true }) lockedUntil: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) lastLoginAt: Date | null;
}

/** Неизменяемый журнал действий сотрудников платформы (только INSERT). */
@Entity('platform_admin_log')
@Index(['createdAt'])
export class PlatformAdminLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @Column({ type: 'uuid' }) adminId: string;
  @Column({ type: 'varchar', length: 60 }) action: string;
  @Column({ type: 'uuid', nullable: true }) tenantId: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) details: Record<string, unknown>;
  @Column({ type: 'varchar', length: 60, nullable: true }) ip: string | null;
}

/**
 * Вход поддержки в магазин (ТЗ 24): только с согласием владельца (разрешение на 24 часа или подтверждение
 * запроса), аварийно — с причиной и уведомлением. По умолчанию чтение; 60 минут; деньги и закупка скрыты.
 */
@Entity('support_sessions')
@Index(['tenantId', 'status'])
export class SupportSession extends PlatformEntity {
  @Column({ type: 'uuid' }) tenantId: string;
  @Column({ type: 'uuid' }) adminId: string;
  /** requested — ждёт владельца; active; ended; declined */
  @Column({ type: 'varchar', length: 10 }) status: 'requested' | 'active' | 'ended' | 'declined';
  @Column({ type: 'varchar', length: 500 }) reason: string;
  @Column({ default: false }) emergency: boolean;
  @Column({ default: false }) canWrite: boolean;
  @Column({ default: false }) showMoney: boolean;
  @Column({ type: 'uuid', nullable: true }) approvedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) endedAt: Date | null;
}

/** Разрешение владельца «Доступ поддержке на 24 часа». */
@Entity('support_grants')
@Index(['tenantId'])
export class SupportGrant extends PlatformEntity {
  @Column({ type: 'uuid' }) tenantId: string;
  @Column({ type: 'uuid' }) grantedBy: string;
  @Column({ type: 'timestamptz' }) until: Date;
  @Column({ default: false }) canWrite: boolean;
  @Column({ default: false }) showMoney: boolean;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;
}

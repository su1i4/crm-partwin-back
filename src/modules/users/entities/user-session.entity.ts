import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Сессия входа (ТЗ 3.5): длинный refresh-токен 30 дней, обновляется при каждом использовании.
 * Платформенная таблица: принадлежит пользователю, tenant_id — какой магазин выбран сейчас.
 */
@Entity('user_sessions')
@Index(['userId', 'revokedAt'])
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'uuid', nullable: true })
  membershipId: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  refreshHash: string;

  /** Предыдущий refresh — принимается 30 секунд после ротации (параллельные вкладки) */
  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  prevRefreshHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rotatedAt: Date | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'varchar', length: 400, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  revokeReason: string | null;
}

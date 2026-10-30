import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

/** Платформенная таблица (без tenant_id): users, tenants, global_* … */
export abstract class PlatformEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * Таблица данных магазина (ТЗ 26): id, tenant_id, created_at, updated_at, created_by.
 * Доступ — только через TenantRepository / TenantTransaction. В миграции — enableRls().
 */
export abstract class TenantEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  tenantId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;
}

/** Справочник или документ: + мягкое удаление и оптимистичная блокировка (ТЗ 2.4.10, 2.4.12). */
export abstract class TenantVersionedEntity extends TenantEntity {
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @VersionColumn({ default: 1 })
  version: number;
}

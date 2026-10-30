import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

export type RegisterMode = 'single' | 'multi';

/** Точка продаж: магазин или контейнер (ТЗ 3.1). */
@Entity('stores')
@Index('uq_stores_tenant_code', ['tenantId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class Store extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** Короткий код для номеров документов: ПН-ОШ-2026-000123 */
  @Column({ type: 'varchar', length: 10 })
  code: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Bishkek' })
  timezone: string;

  /** «Одна касса» / «Несколько касс» — переключается сам по числу активных касс (ТЗ 16.1) */
  @Column({ type: 'varchar', length: 10, default: 'single' })
  registerMode: RegisterMode;

  @Column({ default: true })
  isActive: boolean;
}

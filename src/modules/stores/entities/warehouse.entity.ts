import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Типы складов (ТЗ 3.1). customer — виртуальный «у клиента»: выдача на подбор и реализация. */
export const WAREHOUSE_TYPES = ['sales_floor', 'storage', 'defect', 'scrap', 'customer', 'transit'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

export const WAREHOUSE_TYPE_LABELS: Record<WarehouseType, string> = {
  sales_floor: 'Торговый зал',
  storage: 'Склад',
  defect: 'Брак',
  scrap: 'Лом',
  customer: 'У клиента',
  transit: 'Транзит',
};

@Entity('warehouses')
@Index('uq_warehouses_tenant_code', ['tenantId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
@Index(['tenantId', 'storeId'])
export class Warehouse extends TenantVersionedEntity {
  /** null — центральный склад */
  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  code: string;

  @Column({ type: 'varchar', length: 20, default: 'sales_floor' })
  type: WarehouseType;

  /** Уровень хранения 1 / 2 / 3 (ТЗ 8) */
  @Column({ type: 'smallint', default: 1 })
  storageLevel: number;

  /** Для склада «у клиента»: контрагент (СТО, реализатор) — этап 8–9 */
  @Column({ type: 'uuid', nullable: true })
  counterpartyId: string | null;

  @Column({ default: true })
  isActive: boolean;
}

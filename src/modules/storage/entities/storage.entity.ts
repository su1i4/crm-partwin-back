import { Column, Entity, Index } from 'typeorm';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export type LocationKind = 'zone' | 'rack' | 'shelf' | 'cell';
export type CellType = 'storage' | 'pick' | 'receiving' | 'shipping' | 'defect';

/** Место хранения (ТЗ 8.2–8.3): дерево склад → зона → стеллаж → полка → ячейка. */
@Entity('storage_locations')
@Index(['tenantId', 'warehouseId', 'code'], { unique: true })
export class StorageLocation extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid', nullable: true }) parentId: string | null;
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) name: string | null;
  @Column({ type: 'varchar', length: 6 }) kind: LocationKind;
  @Column({ type: 'varchar', length: 10, default: 'storage' }) cellType: CellType;
  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true }) capacity: string | null;
  /** small | medium | large | floor */
  @Column({ type: 'varchar', length: 8, nullable: true }) sizeClass: string | null;
  @Column({ default: true }) mixed: boolean;
  @Column({ type: 'int', default: 0 }) pickPriority: number;
  @Column({ type: 'int', default: 0 }) walkOrder: number;
  @Column({ default: false }) blocked: boolean;
  @Column({ type: 'jsonb', default: () => "'[]'" }) categoryIds: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) makeIds: string[];
  @Column({ type: 'varchar', length: 40, nullable: true }) barcode: string | null;
  @Column({ type: 'timestamptz', nullable: true }) lastCountedAt: Date | null;
}

/** Место товара: основное и дополнительные (уровень 2) + мин. в ячейке отбора для пополнения. */
@Entity('product_locations')
@Index(['tenantId', 'productId', 'locationId'], { unique: true })
export class ProductLocation extends TenantEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid' }) locationId: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ default: false }) isMain: boolean;
  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true }) minQty: string | null;
}

/** Остаток по ячейкам (уровень 3): ведётся заданиями размещения, подбора, перемещения и пересчёта. */
@Entity('cell_stock')
@Index(['tenantId', 'locationId', 'productId'], { unique: true })
@Index(['tenantId', 'productId'])
export class CellStock extends TenantEntity {
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) locationId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 }) qty: string;
}

export interface TaskLine {
  productId: string;
  qty: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  doneQty?: string;
  /** Пересчёт: сколько насчитали */
  countedQty?: string;
  shortage?: boolean;
}

/** Складское задание (ТЗ 8.3): размещение, подбор по маршруту, пополнение, циклический пересчёт. */
@Entity('warehouse_tasks')
@Index(['tenantId', 'status'])
export class WarehouseTask extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 30 }) number: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'varchar', length: 12 }) kind: 'placement' | 'pick' | 'replenish' | 'count' | 'move';
  @Column({ type: 'varchar', length: 12, default: 'open' }) status: 'open' | 'in_progress' | 'done' | 'cancelled';
  @Column({ type: 'uuid', nullable: true }) assigneeId: string | null;
  @Column({ type: 'jsonb' }) lines: TaskLine[];
  @Column({ type: 'varchar', length: 30, nullable: true }) sourceType: string | null;
  @Column({ type: 'uuid', nullable: true }) sourceId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) doneAt: Date | null;
}

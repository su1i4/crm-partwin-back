import { Column, Entity, Generated, Index, JoinColumn, ManyToOne } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN, QTY_COLUMN } from '../../../common/utils/decimal';
import { COST_AMOUNT_COLUMN } from '../../../common/utils/decimal-ext';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';
import { Product } from '../../catalog/entities/product.entity';
import { Document } from '../../documents/entities/document.entity';
import { Warehouse } from '../../stores/entities/warehouse.entity';

/**
 * in — приход со своей себестоимостью; in_fixed — приход по чужой (пересортица, возврат);
 * out — расход по средней; transfer_out / transfer_in — перемещение; adjustment — корректировка суммы (qty = 0).
 */
export type MovementKind = 'in' | 'in_fixed' | 'out' | 'transfer_out' | 'transfer_in' | 'adjustment';

/** Регистр движений товара (ТЗ 2.4.2). Только вставка/удаление при проведении и отмене. */
@Entity('stock_movements')
@Index(['tenantId', 'productId', 'warehouseId', 'movedAt'])
@Index(['tenantId', 'productId', 'movedAt', 'seq'])
@Index(['tenantId', 'documentId'])
@Index(['tenantId', 'warehouseId', 'movedAt'])
@Index(['tenantId', 'pairOfId'])
export class StockMovement extends TenantEntity {
  @Column({ type: 'uuid' }) documentId: string;
  @ManyToOne(() => Document, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'document_id' })
  document?: Document;

  @Column({ type: 'uuid' }) lineId: string;

  @Column({ type: 'uuid' }) warehouseId: string;
  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warehouse_id' })
  warehouse?: Warehouse;

  @Column({ type: 'uuid' }) productId: string;
  @ManyToOne(() => Product, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Product;

  @Column({ type: 'uuid' }) unitId: string;
  @Column({ type: 'uuid', nullable: true }) serialItemId: string | null;
  /** Ячейка (уровень 3, этап 9) */
  @Column({ type: 'uuid', nullable: true }) locationId: string | null;

  @Column({ type: 'varchar', length: 15 }) kind: MovementKind;
  /** + приход / − расход, в базовой единице */
  @Column(QTY_COLUMN) qty: Decimal;
  /** Сумма себестоимости, со знаком */
  @Column(COST_AMOUNT_COLUMN) costAmount: Decimal;
  /** Для in_fixed / transfer_in — парное движение-расход, от которого берётся сумма */
  @Column({ type: 'uuid', nullable: true }) pairOfId: string | null;

  @Column({ type: 'timestamptz' }) movedAt: Date;
  /** Порядок внутри одного времени */
  @Column({ type: 'bigint' })
  @Generated('increment')
  seq: string;
}

/** Кэш остатков (ТЗ 2.4.1): обновляется в той же транзакции, что и проведение. */
@Entity('stock_balances')
@Index('uq_stock_balances', { synchronize: false }) // (tenant_id, warehouse_id, product_id, COALESCE(location_id, 0-uuid)) — в миграции
@Index(['tenantId', 'productId'])
@Index(['tenantId', 'warehouseId'])
export class StockBalance extends TenantEntity {
  @Column({ type: 'uuid' }) warehouseId: string;
  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'warehouse_id' })
  warehouse?: Warehouse;

  @Column({ type: 'uuid' }) productId: string;
  @ManyToOne(() => Product, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Product;

  @Column({ type: 'uuid', nullable: true }) locationId: string | null;
  @Column({ ...QTY_COLUMN, default: '0' }) qty: Decimal;
  @Column({ ...COST_AMOUNT_COLUMN, default: '0' }) costAmount: Decimal;
}

/** Средняя себестоимость товара в целом по магазину (ТЗ 7.3). */
@Entity('product_costs')
@Index('uq_product_costs', ['tenantId', 'productId'], { unique: true })
export class ProductCost extends TenantEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ ...QTY_COLUMN, default: '0' }) qty: Decimal;
  @Column({ ...COST_AMOUNT_COLUMN, default: '0' }) costAmount: Decimal;
  /** Последняя известная себестоимость за единицу (для продажи в минус) */
  @Column({ ...COST_COLUMN, default: '0' }) lastUnitCost: Decimal;
}

/** Очередь пересчёта себестоимости «товар X с даты Д» (ТЗ 7.3). Один товар — одна строка с самой ранней датой. */
@Entity('cost_recalc_queue')
@Index('uq_cost_recalc_queue', ['tenantId', 'productId'], { unique: true })
export class CostRecalcQueue extends TenantEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'timestamptz' }) fromDate: Date;
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
}

/** Место хранения уровня 1: текст для пары «товар + склад» (ТЗ 8.1). */
@Entity('product_places')
@Index('uq_product_places', ['tenantId', 'warehouseId', 'productId'], { unique: true })
@Index(['tenantId', 'warehouseId', 'place'])
export class ProductPlace extends TenantEntity {
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'varchar', length: 50 }) place: string;
}

export type SerialStatus = 'in_stock' | 'in_transit' | 'sold' | 'written_off' | 'returned';

/** Серийный экземпляр: б/у детали, АКБ, агрегаты (ТЗ 7.2). */
@Entity('serial_items')
@Index(['tenantId', 'productId', 'status'])
@Index('uq_serial_items_number', ['tenantId', 'productId', 'serialNumber'], { unique: true, where: 'deleted_at IS NULL' })
export class SerialItem extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'varchar', length: 80 }) serialNumber: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) inventoryNumber: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) condition: string | null;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) photoFileIds: string[];
  /** Своя цена экземпляра (по желанию) */
  @Column({ ...MONEY_COLUMN, nullable: true }) price: Decimal | null;
  @Column({ type: 'uuid', nullable: true }) warehouseId: string | null;
  @Column({ type: 'varchar', length: 50, nullable: true }) place: string | null;
  @Column({ type: 'varchar', length: 15, default: 'in_stock' }) status: SerialStatus;
  /** Документ, которым экземпляр пришёл */
  @Column({ type: 'uuid', nullable: true }) sourceDocumentId: string | null;
  /** Донор (этап 9.4) */
  @Column({ type: 'uuid', nullable: true }) donorId: string | null;
}

/** Снимок остатков и себестоимости на конец закрытого месяца (ТЗ 7.5). */
@Entity('stock_snapshots')
@Index(['tenantId', 'periodEnd', 'productId'])
@Index('uq_stock_snapshots', ['tenantId', 'periodEnd', 'warehouseId', 'productId'], { unique: true })
export class StockSnapshot extends TenantEntity {
  /** Конец месяца (момент, до которого включительно учтены движения) */
  @Column({ type: 'timestamptz' }) periodEnd: Date;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column(QTY_COLUMN) qty: Decimal;
  @Column(COST_AMOUNT_COLUMN) costAmount: Decimal;
}

/** Закрытие периода (ТЗ 7.5). */
@Entity('period_closes')
@Index('uq_period_closes_month', ['tenantId', 'month'], { unique: true })
export class PeriodClose extends TenantEntity {
  /** Первый день месяца YYYY-MM-01 */
  @Column({ type: 'date' }) month: string;
  /** Граница: всё до этого момента (UTC) неизменяемо */
  @Column({ type: 'timestamptz' }) periodEnd: Date;
  @Column({ type: 'varchar', length: 10, default: 'closed' }) status: 'closed' | 'reopened';
  @Column({ type: 'timestamptz' }) closedAt: Date;
  @Column({ type: 'uuid', nullable: true }) closedBy: string | null;
  @Column({ type: 'timestamptz', nullable: true }) reopenedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) reopenedBy: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) reopenReason: string | null;
}

/** Лист подсчёта инвентаризации — несколько параллельно (ТЗ 9.3). */
@Entity('inventory_sheets')
@Index(['tenantId', 'documentId'])
export class InventorySheet extends TenantEntity {
  @Column({ type: 'uuid' }) documentId: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'uuid', nullable: true }) assignedTo: string | null;
  @Column({ type: 'varchar', length: 10, default: 'open' }) status: 'open' | 'done';
}

/**
 * Скан при инвентаризации. Учётное количество берётся на время скана (scannedAt) — продажи не останавливаются.
 * Несколько сканов одного товара в разных листах суммируются.
 */
@Entity('inventory_counts')
@Index(['tenantId', 'documentId', 'productId'])
export class InventoryCount extends TenantEntity {
  @Column({ type: 'uuid' }) documentId: string;
  @Column({ type: 'uuid' }) sheetId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid', nullable: true }) serialItemId: string | null;
  /** В базовой единице */
  @Column(QTY_COLUMN) qty: Decimal;
  @Column({ type: 'timestamptz' }) scannedAt: Date;
  @Column({ type: 'varchar', length: 50, nullable: true }) place: string | null;
}

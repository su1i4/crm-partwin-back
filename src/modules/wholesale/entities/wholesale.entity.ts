import { Column, Entity, Index } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export type ContainerStatus = 'draft' | 'paid' | 'in_transit' | 'customs' | 'received';

/** Контейнер (ТЗ 10.8): поставщик, предоплаты в валюте, карго, статусы; пока в пути — товар «ожидается». */
@Entity('containers')
@Index(['tenantId', 'status'])
export class Container extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 30 }) number: string;
  @Column({ type: 'uuid' }) supplierId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'varchar', length: 3, default: 'USD' }) currency: string;
  @Column({ ...COST_COLUMN, nullable: true }) rate: Decimal | null;
  @Column({ type: 'varchar', length: 12, default: 'draft' }) status: ContainerStatus;
  /** Предоплаты: [{ at, amount, currency, accountId, movementId }] */
  @Column({ type: 'jsonb', default: () => "'[]'" }) prepayments: Record<string, any>[];
  /** Расходы: карго, таможня, доставка — [{ name, amount, currency }] в сомах после пересчёта */
  @Column({ type: 'jsonb', default: () => "'[]'" }) costs: { name: string; amount: string; currency: string }[];
  /** Распределение расходов: volume | weight | amount | manual */
  @Column({ type: 'varchar', length: 10, default: 'amount' }) distribution: 'volume' | 'weight' | 'amount' | 'manual';
  @Column({ type: 'date', nullable: true }) expectedOn: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) receivingDocumentIds: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) history: { at: string; status: string; by: string | null }[];
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
}

@Entity('container_lines')
@Index(['tenantId', 'containerId'])
export class ContainerLine extends TenantEntity {
  @Column({ type: 'uuid' }) containerId: string;
  @Column({ type: 'int' }) lineNo: number;
  /** Как в инвойсе (англ. / кит.) */
  @Column({ type: 'varchar', length: 100, nullable: true }) invoiceCode: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) invoiceName: string | null;
  @Column({ type: 'uuid', nullable: true }) productId: string | null;
  @Column({ type: 'numeric', precision: 18, scale: 3 }) qty: string;
  @Column(COST_COLUMN) price: Decimal;
  @Column({ type: 'numeric', precision: 12, scale: 4, nullable: true }) volume: string | null;
  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true }) weight: string | null;
  /** Ручное распределение расходов, сом */
  @Column({ ...MONEY_COLUMN, nullable: true }) manualCost: Decimal | null;
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 }) receivedQty: string;
  /** Бой / пересорт при приёмке */
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 }) damagedQty: string;
}

/** Запомненное сопоставление «код / название из инвойса → наш товар» по поставщику. */
@Entity('invoice_mappings')
@Index(['tenantId', 'supplierId', 'key'], { unique: true })
export class InvoiceMapping extends TenantEntity {
  @Column({ type: 'uuid' }) supplierId: string;
  @Column({ type: 'varchar', length: 300 }) key: string;
  @Column({ type: 'uuid' }) productId: string;
}

export type SalesOrderStatus = 'new' | 'reserved' | 'partially_shipped' | 'shipped' | 'cancelled';
export type DeliveryStatus = 'assembled' | 'on_way' | 'delivered' | 'paid' | 'returned';

/** Заказ покупателя (ТЗ 14.3): резерв, цена фиксируется, предоплата, частичная отгрузка; доставка (14.4). */
@Entity('sales_orders')
@Index(['tenantId', 'status'])
export class SalesOrder extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 30 }) number: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'varchar', length: 20, default: 'new' }) status: SalesOrderStatus;
  @Column({ ...MONEY_COLUMN, default: '0' }) total: Decimal;
  @Column({ type: 'jsonb', default: () => "'[]'" }) prepaymentItemIds: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) receiptIds: string[];
  @Column({ type: 'date', nullable: true }) dueOn: string | null;
  // Доставка
  @Column({ type: 'varchar', length: 300, nullable: true }) address: string | null;
  @Column({ type: 'uuid', nullable: true }) driverId: string | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) deliveryCost: Decimal | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) deliveryStatus: DeliveryStatus | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) history: { at: string; status: string; by: string | null; note?: string }[];
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
}

@Entity('sales_order_lines')
@Index(['tenantId', 'orderId'])
@Index(['tenantId', 'productId'])
export class SalesOrderLine extends TenantEntity {
  @Column({ type: 'uuid' }) orderId: string;
  @Column({ type: 'int' }) lineNo: number;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid', nullable: true }) warehouseId: string | null;
  @Column({ type: 'numeric', precision: 18, scale: 3 }) qty: string;
  @Column(MONEY_COLUMN) price: Decimal;
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 }) shippedQty: string;
}

/** Реализатор: что передали, что продано (долг), что вернули (ТЗ 14.10). */
@Entity('consignment_reports')
@Index(['tenantId', 'counterpartyId'])
export class ConsignmentReport extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'uuid' }) returnDocumentId: string;
  @Column({ type: 'uuid', nullable: true }) receiptId: string | null;
  @Column(MONEY_COLUMN) amount: Decimal;
}

/** Донор (ТЗ 14.12): машина, вложения; детали приходуются частями, себестоимость — доля стоимости донора. */
@Entity('donors')
export class Donor extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 30 }) number: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'uuid', nullable: true }) makeId: string | null;
  @Column({ type: 'uuid', nullable: true }) modelId: string | null;
  @Column({ type: 'uuid', nullable: true }) generationId: string | null;
  @Column({ type: 'smallint', nullable: true }) year: number | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) vin: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) bodyCode: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) engine: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) transmission: string | null;
  @Column({ ...MONEY_COLUMN, default: '0' }) purchasePrice: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) deliveryCost: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) customsCost: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) otherCost: Decimal;
  /** Ожидаемая выручка со всех деталей — база для доли себестоимости */
  @Column({ ...MONEY_COLUMN, default: '0' }) expectedTotal: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) distributed: Decimal;
  @Column({ type: 'jsonb', default: () => "'[]'" }) documentIds: string[];
  @Column({ type: 'varchar', length: 10, default: 'open' }) status: 'open' | 'closed';
  @Column({ type: 'uuid', nullable: true }) counterpartyId: string | null;
}

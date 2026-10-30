import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN, QTY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

// ── Товар у поставщика и правила запаса ───────────────────

/** Товар у поставщика (ТЗ 10.1, 10.4): код поставщика, кратность, мин. партия, срок, последняя цена. */
@Entity('supplier_products')
@Index('uq_supplier_products', ['tenantId', 'supplierId', 'productId'], { unique: true })
@Index(['tenantId', 'productId'])
export class SupplierProduct extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) supplierId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) supplierCode: string | null;
  @Column({ ...QTY_COLUMN, default: '1' }) multiplicity: Decimal;
  @Column({ ...QTY_COLUMN, default: '0' }) minQty: Decimal;
  @Column({ type: 'int', nullable: true }) leadDays: number | null;
  @Column({ ...COST_COLUMN, nullable: true }) lastPrice: Decimal | null;
  @Column({ type: 'varchar', length: 3, nullable: true }) lastCurrency: string | null;
  @Column({ type: 'timestamptz', nullable: true }) lastPurchaseAt: Date | null;
  @Column({ default: false }) preferred: boolean;
}

/** Мин./макс. остаток товара (на точку или все), сезонные значения лето / зима (ТЗ 10.4). */
@Entity('stock_rules')
@Index('uq_stock_rules', ['tenantId', 'productId', 'storeKey'], { unique: true })
export class StockRule extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  /** storeId или '' — для уникальности «все точки» */
  @Column({ type: 'varchar', length: 36, default: '' }) storeKey: string;
  @Column({ ...QTY_COLUMN, nullable: true }) minQty: Decimal | null;
  @Column({ ...QTY_COLUMN, nullable: true }) maxQty: Decimal | null;
  @Column({ ...QTY_COLUMN, nullable: true }) summerMin: Decimal | null;
  @Column({ ...QTY_COLUMN, nullable: true }) summerMax: Decimal | null;
  @Column({ ...QTY_COLUMN, nullable: true }) winterMin: Decimal | null;
  @Column({ ...QTY_COLUMN, nullable: true }) winterMax: Decimal | null;
  /** Основной поставщик для автозаказа */
  @Column({ type: 'uuid', nullable: true }) supplierId: string | null;
}

// ── Прайсы поставщиков (ТЗ 10.2) ──────────────────────────

export interface PriceListMapping {
  brand?: number;
  number?: number;
  name?: number;
  price?: number;
  currency?: number;
  stock?: number;
  leadDays?: number;
  multiplicity?: number;
  oem?: number;
  applicability?: number;
}

/** Прайс поставщика: файл или ссылка, сопоставление колонок запоминается, обновление по расписанию. */
@Entity('price_lists')
@Index(['tenantId', 'supplierId'])
export class PriceList extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) supplierId: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  @Column({ type: 'varchar', length: 1000, nullable: true }) url: string | null;
  /** null — вручную; hourly | every_6h | daily */
  @Column({ type: 'varchar', length: 10, nullable: true }) schedule: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) mapping: PriceListMapping;
  @Column({ type: 'int', default: 1 }) headerRow: number;
  /** Срок поставки по умолчанию, дней */
  @Column({ type: 'int', nullable: true }) defaultLeadDays: number | null;
  @Column({ type: 'varchar', length: 12, default: 'empty' }) status: 'empty' | 'loading' | 'ready' | 'failed';
  @Column({ type: 'int', default: 0 }) rowsCount: number;
  @Column({ type: 'timestamptz', nullable: true }) loadedAt: Date | null;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  @Column({ default: true }) isActive: boolean;
}

/** Строка прайса — отдельно от каталога, до миллионов строк, индекс по нормализованному номеру. */
@Entity('price_list_rows')
@Index('uq_price_list_rows', ['tenantId', 'priceListId', 'normalized', 'brandKey'], { unique: true })
@Index(['tenantId', 'normalized'])
@Index(['tenantId', 'productId'])
export class PriceListRow extends TenantEntity {
  @Column({ type: 'uuid' }) priceListId: string;
  @ManyToOne(() => PriceList, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'price_list_id' })
  priceList?: PriceList;
  @Column({ type: 'uuid' }) supplierId: string;
  @Column({ type: 'uuid', nullable: true }) brandId: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) brandText: string | null;
  @Column({ type: 'varchar', length: 100, default: '' }) brandKey: string;
  @Column({ type: 'varchar', length: 80 }) number: string;
  @Column({ type: 'varchar', length: 80 }) normalized: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) name: string | null;
  @Column({ ...COST_COLUMN, nullable: true }) price: Decimal | null;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  /** Остаток как в прайсе («>10», «есть») и число, если удалось понять */
  @Column({ type: 'varchar', length: 30, nullable: true }) stockText: string | null;
  @Column({ ...QTY_COLUMN, nullable: true }) stockQty: Decimal | null;
  @Column({ type: 'int', nullable: true }) leadDays: number | null;
  @Column({ ...QTY_COLUMN, nullable: true }) multiplicity: Decimal | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) oem: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) applicability: string | null;
  /** Товар каталога с тем же номером и брендом */
  @Column({ type: 'uuid', nullable: true }) productId: string | null;
  @Column({ type: 'uuid', nullable: true }) loadId: string | null;
}

/** Загрузка прайса: история. */
@Entity('price_list_loads')
@Index(['tenantId', 'priceListId', 'createdAt'])
export class PriceListLoad extends TenantEntity {
  @Column({ type: 'uuid' }) priceListId: string;
  @Column({ type: 'uuid', nullable: true }) fileId: string | null;
  @Column({ type: 'varchar', length: 10 }) source: 'file' | 'url';
  @Column({ type: 'varchar', length: 12, default: 'queued' }) status: 'queued' | 'running' | 'done' | 'failed';
  @Column({ type: 'int', default: 0 }) rows: number;
  @Column({ type: 'int', default: 0 }) added: number;
  @Column({ type: 'int', default: 0 }) updated: number;
  @Column({ type: 'int', default: 0 }) removed: number;
  @Column({ type: 'int', default: 0 }) priceChanges: number;
  @Column({ type: 'int', default: 0 }) skipped: number;
  @Column({ type: 'int', default: 0 }) crossesAdded: number;
  @Column({ type: 'text', nullable: true }) error: string | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date | null;
}

/** История изменения цен в прайсе. */
@Entity('price_list_price_history')
@Index(['tenantId', 'priceListId', 'normalized'])
export class PriceListPriceHistory extends TenantEntity {
  @Column({ type: 'uuid' }) priceListId: string;
  @Column({ type: 'varchar', length: 80 }) normalized: string;
  @Column({ type: 'varchar', length: 100, default: '' }) brandKey: string;
  @Column({ ...COST_COLUMN, nullable: true }) oldPrice: Decimal | null;
  @Column({ ...COST_COLUMN, nullable: true }) newPrice: Decimal | null;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column({ type: 'uuid', nullable: true }) loadId: string | null;
}

// ── Заказ поставщику (ТЗ 10.3) ────────────────────────────

export const ORDER_STATUSES = ['draft', 'sent', 'confirmed', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

@Entity('purchase_orders')
@Index('uq_purchase_orders_number', ['tenantId', 'number'], { unique: true })
@Index(['tenantId', 'supplierId', 'status'])
@Index(['tenantId', 'status', 'createdAt'])
export class PurchaseOrder extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) supplierId: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid', nullable: true }) warehouseId: string | null;
  @Column({ type: 'varchar', length: 20, default: 'draft' }) status: OrderStatus;
  /** manual | auto | request */
  @Column({ type: 'varchar', length: 10, default: 'manual' }) source: string;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  @Column({ ...MONEY_COLUMN, default: '0' }) totalAmount: Decimal;
  @Column({ type: 'date', nullable: true }) expectedAt: string | null;
  @Column({ type: 'timestamptz', nullable: true }) sentAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) history: { at: string; status: string; by: string | null; note?: string }[];
}

@Entity('purchase_order_lines')
@Index(['tenantId', 'orderId'])
@Index(['tenantId', 'productId'])
export class PurchaseOrderLine extends TenantEntity {
  @Column({ type: 'uuid' }) orderId: string;
  @ManyToOne(() => PurchaseOrder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order?: PurchaseOrder;
  @Column({ type: 'int' }) lineNo: number;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid' }) unitId: string;
  @Column(QTY_COLUMN) factor: Decimal;
  @Column(QTY_COLUMN) qty: Decimal;
  @Column({ ...COST_COLUMN, nullable: true }) price: Decimal | null;
  @Column({ ...QTY_COLUMN, default: '0' }) receivedQty: Decimal;
  /** Строка из заявки клиента */
  @Column({ type: 'uuid', nullable: true }) requestItemId: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) note: string | null;
  /** Почему автозаказ предложил это количество */
  @Column({ type: 'jsonb', default: () => "'{}'" }) extra: Record<string, any>;
}

// ── Заявка клиента (ТЗ 14.1) и лист ожидания (18.4) ───────

export const REQUEST_STATUSES = ['new', 'selecting', 'offered', 'ordered', 'arrived', 'issued', 'refused'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

@Entity('customer_requests')
@Index('uq_customer_requests_number', ['tenantId', 'number'], { unique: true })
@Index(['tenantId', 'storeId', 'status'])
@Index(['tenantId', 'customerId'])
export class CustomerRequest extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) storeId: string;
  /** select — «подобрать»; order — «привезти под заказ» */
  @Column({ type: 'varchar', length: 10, default: 'order' }) kind: 'select' | 'order';
  @Column({ type: 'varchar', length: 12, default: 'new' }) status: RequestStatus;
  @Column({ type: 'uuid', nullable: true }) customerId: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) customerName: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) customerPhone: string | null;
  @Column({ type: 'uuid', nullable: true }) customerVehicleId: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) vehicleText: string | null;
  @Column({ type: 'uuid', nullable: true }) assigneeId: string | null;
  /** Когда привезут / срок ответа клиенту */
  @Column({ type: 'timestamptz', nullable: true }) dueAt: Date | null;
  @Column({ ...MONEY_COLUMN, default: '0' }) prepaid: Decimal;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) prepaymentItemIds: string[];
  @Column({ type: 'uuid', nullable: true }) receiptId: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) refuseReason: string | null;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) overdueNotifiedAt: Date | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) history: { at: string; status: string; by: string | null; note?: string }[];
}

export interface RequestOffer {
  id: string;
  productId?: string | null;
  name: string;
  brand?: string | null;
  qualityClass?: string | null;
  price: string;
  supplierId?: string | null;
  purchasePrice?: string | null;
  leadDays?: number | null;
  inStock?: boolean;
  chosen?: boolean;
}

@Entity('customer_request_items')
@Index(['tenantId', 'requestId'])
export class CustomerRequestItem extends TenantEntity {
  @Column({ type: 'uuid' }) requestId: string;
  @ManyToOne(() => CustomerRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request?: CustomerRequest;
  @Column({ type: 'int' }) lineNo: number;
  /** Что нужно: номер, название, фото */
  @Column({ type: 'varchar', length: 80, nullable: true }) number: string | null;
  @Column({ type: 'varchar', length: 300 }) name: string;
  @Column({ ...QTY_COLUMN, default: '1' }) qty: Decimal;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) photoFileIds: string[];
  /** Выбранный товар (после подбора) */
  @Column({ type: 'uuid', nullable: true }) productId: string | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) salePrice: Decimal | null;
  /** У кого заказали: поставщик или сосед */
  @Column({ type: 'uuid', nullable: true }) sourceId: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) sourceKind: 'supplier' | 'neighbor' | null;
  @Column({ ...COST_COLUMN, nullable: true }) purchasePrice: Decimal | null;
  @Column({ type: 'uuid', nullable: true }) purchaseOrderLineId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) arrivedAt: Date | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) offers: RequestOffer[];
}

@Entity('waitlist_entries')
@Index(['tenantId', 'productId', 'status'])
@Index(['tenantId', 'storeId', 'status'])
export class WaitlistEntry extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid', nullable: true }) productId: string | null;
  /** Если товара нет в каталоге — что искали */
  @Column({ type: 'varchar', length: 300, nullable: true }) query: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) normalized: string | null;
  @Column({ type: 'uuid', nullable: true }) customerId: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) customerName: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) customerPhone: string | null;
  @Column({ ...QTY_COLUMN, default: '1' }) qty: Decimal;
  @Column({ type: 'varchar', length: 12, default: 'waiting' }) status: 'waiting' | 'notified' | 'done' | 'cancelled';
  @Column({ type: 'timestamptz', nullable: true }) notifiedAt: Date | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) note: string | null;
}

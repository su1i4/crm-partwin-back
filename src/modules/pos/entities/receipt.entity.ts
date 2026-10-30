import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN, QTY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';
import { Document } from '../../documents/entities/document.entity';

/** open — набирается; deferred — отложен; completed — оплачен (документ проведён); cancelled — отменён до оплаты */
export type ReceiptStatus = 'open' | 'deferred' | 'completed' | 'cancelled';

/** Подтверждение PIN старшего: что разрешил и кто. */
export interface ReceiptApproval {
  action: 'discount' | 'below_cost' | 'credit_over_limit' | 'credit_overdue' | 'delete_line' | 'custom_price';
  membershipId: string;
  name: string;
  at: string;
}

/**
 * Чек (ТЗ 13). Товарная часть — документ вида sale (строки, движения, себестоимость), здесь — кассовая шапка:
 * смена, продавец, клиент, машина, мастер, итоги и оплаты. Возврат — тоже чек (kind = return), документ sale_return.
 */
@Entity('receipts')
@Index('uq_receipts_document', ['tenantId', 'documentId'], { unique: true })
@Index('uq_receipts_idempotency', ['tenantId', 'idempotencyKey'], { unique: true, where: 'idempotency_key IS NOT NULL' })
@Index('uq_receipts_public_token', ['publicToken'], { unique: true, where: 'public_token IS NOT NULL' })
@Index(['tenantId', 'storeId', 'status'])
@Index(['tenantId', 'shiftId'])
@Index(['tenantId', 'customerId', 'createdAt'])
export class Receipt extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) documentId: string;
  @ManyToOne(() => Document, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'document_id' })
  document?: Document;
  @Column({ type: 'varchar', length: 10, default: 'sale' }) kind: 'sale' | 'return';
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) registerId: string;
  @Column({ type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'uuid' }) sellerMembershipId: string;
  @Column({ type: 'varchar', length: 12, default: 'open' }) status: ReceiptStatus;
  @Column({ type: 'uuid', nullable: true }) customerId: string | null;
  @Column({ type: 'uuid', nullable: true }) customerVehicleId: string | null;
  /** Госномер / номер заказ-наряда СТО (если машины нет в гараже) */
  @Column({ type: 'varchar', length: 60, nullable: true }) vehicleLabel: string | null;
  /** «Привёл мастер» — на чеке не печатается */
  @Column({ type: 'uuid', nullable: true }) masterId: string | null;
  @Column({ type: 'uuid', nullable: true }) priceTypeId: string | null;
  /** Промокод акции (ТЗ 17.6) */
  @Column({ type: 'varchar', length: 40, nullable: true }) promoCode: string | null;
  /** Оплата бонусами с карты клиента (ТЗ 17.7) */
  @Column({ ...MONEY_COLUMN, default: '0' }) bonusAmount: Decimal;
  /** Какие акции сработали: [{id, name}] */
  @Column({ type: 'jsonb', default: () => "'[]'" }) promotions: { id: string; name: string }[];
  /** Скидка на весь чек: процент или сумма */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true }) receiptDiscountPercent: string | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) receiptDiscountAmount: Decimal | null;
  @Column({ ...MONEY_COLUMN, default: '0' }) subtotal: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) discountTotal: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) total: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) paid: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) change: Decimal;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) changeCurrency: string;
  @Column({ ...MONEY_COLUMN, default: '0' }) debtAmount: Decimal;
  /** Курс магазина USD на момент открытия чека */
  @Column({ ...COST_COLUMN, nullable: true }) rate: Decimal | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) approvals: ReceiptApproval[];
  /** Подпись отложенного чека: «Азамат, Камри» */
  @Column({ type: 'varchar', length: 100, nullable: true }) label: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) idempotencyKey: string | null;
  /** Токен ссылки на электронный чек (QR) */
  @Column({ type: 'varchar', length: 80, nullable: true }) publicToken: string | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  /** Возврат: исходный чек продажи */
  @Column({ type: 'uuid', nullable: true }) originalReceiptId: string | null;
  /** Офлайн-чек (ТЗ 16.4): устройство, время на устройстве и время получения сервером, пометки конфликтов */
  @Column({ type: 'uuid', nullable: true }) deviceId: string | null;
  @Column({ default: false }) offline: boolean;
  @Column({ type: 'timestamptz', nullable: true }) deviceCreatedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) receivedAt: Date | null;
  /** stalePrice, negativeStock, clockSkew, closedPeriod, debtOverLimit, offlineViolation */
  @Column({ type: 'jsonb', default: () => "'{}'" }) flags: Record<string, any>;
}

export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'debt', 'return_credit', 'advance', 'scrap'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Оплата чека (или выплата по возврату — amount < 0). */
@Entity('receipt_payments')
@Index(['tenantId', 'receiptId'])
@Index(['tenantId', 'moneyMovementId'])
export class ReceiptPayment extends TenantEntity {
  @Column({ type: 'uuid' }) receiptId: string;
  @ManyToOne(() => Receipt, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'receipt_id' })
  receipt?: Receipt;
  @Column({ type: 'varchar', length: 15 }) method: PaymentMethod;
  @Column({ type: 'uuid', nullable: true }) accountId: string | null;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  /** В валюте оплаты (без сдачи) */
  @Column(MONEY_COLUMN) amount: Decimal;
  /** Зачтено в сомах */
  @Column(MONEY_COLUMN) amountKgs: Decimal;
  @Column({ ...COST_COLUMN, default: '1' }) rate: Decimal;
  @Column({ type: 'uuid', nullable: true }) fileId: string | null;
  @Column({ type: 'uuid', nullable: true }) moneyMovementId: string | null;
  @Column({ type: 'uuid', nullable: true }) debtItemId: string | null;
  /** Оплата зачётом возврата (обмен): какой возврат */
  @Column({ type: 'uuid', nullable: true }) sourceReceiptId: string | null;
  /** Оплата авансом / предоплатой: какие позиции аванса списаны */
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) advanceItemIds: string[];
}

/** «Взял у соседа» (ТЗ 14.2): приход от соседа + продажа + долг соседу + прибыль по позиции. */
@Entity('neighbor_purchases')
@Index(['tenantId', 'neighborId', 'createdAt'])
@Index(['tenantId', 'documentId'])
export class NeighborPurchase extends TenantEntity {
  @Column({ type: 'uuid' }) neighborId: string;
  @Column({ type: 'uuid' }) documentId: string;
  @Column({ type: 'uuid' }) lineId: string;
  @Column({ type: 'varchar', length: 300 }) name: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) partNumber: string | null;
  /** Карточка товара, к которой привязали позицию (можно позже) */
  @Column({ type: 'uuid', nullable: true }) productId: string | null;
  @Column(QTY_COLUMN) qty: Decimal;
  @Column(MONEY_COLUMN) purchasePrice: Decimal;
  @Column(MONEY_COLUMN) salePrice: Decimal;
  @Column({ type: 'uuid', nullable: true }) debtItemId: string | null;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
}

export type WarrantyStatus = 'accepted' | 'checking' | 'sent_to_supplier' | 'decided';
export type WarrantyDecision = 'replace' | 'refund' | 'reject';

/** Гарантийное обращение (ТЗ 15.3). */
@Entity('warranty_claims')
@Index('uq_warranty_claims_number', ['tenantId', 'number'], { unique: true })
@Index(['tenantId', 'status'])
export class WarrantyClaim extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'varchar', length: 20, default: 'accepted' }) status: WarrantyStatus;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) saleReceiptId: string | null;
  @Column({ type: 'uuid', nullable: true }) saleLineId: string | null;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid', nullable: true }) serialItemId: string | null;
  @Column({ type: 'uuid', nullable: true }) customerId: string | null;
  @Column({ type: 'uuid', nullable: true }) supplierId: string | null;
  @Column({ ...QTY_COLUMN, default: '1' }) qty: Decimal;
  @Column({ type: 'text' }) complaint: string;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) photoFileIds: string[];
  /** Срок гарантии на момент приёма: в гарантии / истёк */
  @Column({ default: true }) inWarranty: boolean;
  @Column({ type: 'varchar', length: 10, nullable: true }) decision: WarrantyDecision | null;
  @Column({ type: 'text', nullable: true }) decisionReason: string | null;
  @Column({ type: 'uuid', nullable: true }) returnReceiptId: string | null;
  @Column({ type: 'uuid', nullable: true }) replacementReceiptId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decidedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) decidedBy: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) history: { at: string; status: string; by: string | null; note?: string }[];
}

/** «Не подошло» с машиной (ТЗ 6.5): пометка на товаре «есть возвраты на Ipsum 2003» + задача проверить применимость. */
@Entity('product_fit_issues')
@Index(['tenantId', 'productId'])
export class ProductFitIssue extends TenantEntity {
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'varchar', length: 200 }) vehicleTitle: string;
  @Column({ type: 'uuid', nullable: true }) customerVehicleId: string | null;
  @Column({ type: 'uuid', nullable: true }) returnReceiptId: string | null;
  @Column({ default: false }) resolved: boolean;
}

import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN, QTY_COLUMN } from '../../../common/utils/decimal';
import { COST_AMOUNT_COLUMN } from '../../../common/utils/decimal-ext';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Виды документов: склад (этап 2), продажи и возвраты (этап 3), закупки (этап 4). */
export const DOCUMENT_TYPES = {
  initial_stock: { prefix: 'ВО', label: 'Ввод начальных остатков' },
  receiving: { prefix: 'ПН', label: 'Приёмка' },
  surplus: { prefix: 'ОП', label: 'Оприходование' },
  writeoff: { prefix: 'СП', label: 'Списание' },
  resort: { prefix: 'ПС', label: 'Пересортица' },
  transfer: { prefix: 'ПМ', label: 'Перемещение' },
  inventory: { prefix: 'ИН', label: 'Инвентаризация' },
  cost_adjustment: { prefix: 'КС', label: 'Корректировка себестоимости' },
  sale: { prefix: 'ЧК', label: 'Продажа' },
  sale_return: { prefix: 'ВЗ', label: 'Возврат покупателя' },
  supplier_return: { prefix: 'ВП', label: 'Возврат поставщику' },
  extra_costs: { prefix: 'ДР', label: 'Доп. расходы' },
  selection_issue: { prefix: 'ВД', label: 'Выдача на подбор' },
  selection_return: { prefix: 'ВВ', label: 'Возврат с подбора' },
  customer_purchase: { prefix: 'ПК', label: 'Покупка у клиента' },
  consignment: { prefix: 'РЛ', label: 'Передача на реализацию' },
  consignment_return: { prefix: 'РВ', label: 'Возврат с реализации' },
  donor: { prefix: 'ДН', label: 'Разборка донора' },
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;

/** draft — черновик; awaiting_approval — списание ждёт согласования; posted — проведён */
export type DocumentStatus = 'draft' | 'awaiting_approval' | 'posted';

/**
 * Общая шапка документа (ТЗ 9, 26). Особые поля вида — в extra.
 * Любое движение товара или денег — проведённый документ (ТЗ 2.4.1).
 */
@Entity('documents')
@Index('uq_documents_number', ['tenantId', 'number'], { unique: true })
@Index(['tenantId', 'type', 'docDate'])
@Index(['tenantId', 'status', 'docDate'])
@Index(['tenantId', 'storeId', 'docDate'])
@Index(['tenantId', 'counterpartyId'])
export class Document extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 30 }) type: DocumentType;
  @Column({ type: 'varchar', length: 40 }) number: string;
  /** Дата документа = время движений */
  @Column({ type: 'timestamptz' }) docDate: Date;
  @Column({ type: 'varchar', length: 20, default: 'draft' }) status: DocumentStatus;
  @Column({ default: false }) deletionMark: boolean;

  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  /** Склад (для перемещения — откуда) */
  @Column({ type: 'uuid', nullable: true }) warehouseId: string | null;
  /** Для перемещения — куда */
  @Column({ type: 'uuid', nullable: true }) warehouseToId: string | null;
  @Column({ type: 'uuid', nullable: true }) counterpartyId: string | null;

  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  /** Курс документа к сому */
  @Column({ ...COST_COLUMN, default: '1' }) rate: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) totalAmount: Decimal;
  @Column({ ...QTY_COLUMN, default: '0' }) totalQty: Decimal;

  @Column({ type: 'uuid', nullable: true }) baseDocumentId: string | null;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) extra: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: true }) postedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) postedBy: string | null;
  /** При проведении остаток ушёл в минус (разрешено настройкой) */
  @Column({ default: false }) hasNegative: boolean;
}

/** Строка документа. Количество — в единице строки, baseQty — в базовой. */
@Entity('document_lines')
@Index(['tenantId', 'documentId', 'lineNo'])
@Index(['tenantId', 'productId'])
export class DocumentLine extends TenantEntity {
  @Column({ type: 'uuid' }) documentId: string;
  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'document_id' })
  document?: Document;

  @Column({ type: 'int' }) lineNo: number;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid' }) unitId: string;
  @Column(QTY_COLUMN) factor: Decimal;
  @Column(QTY_COLUMN) qty: Decimal;
  @Column(QTY_COLUMN) baseQty: Decimal;
  /** Цена за единицу строки в валюте документа (null — «ожидает цен») */
  @Column({ ...COST_COLUMN, nullable: true }) price: Decimal | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) amount: Decimal | null;
  /** Себестоимость за базовую единицу в сомах — считается при проведении */
  @Column({ ...COST_COLUMN, nullable: true }) unitCost: Decimal | null;
  @Column({ ...COST_AMOUNT_COLUMN, nullable: true }) costAmount: Decimal | null;
  /** Пересортица: во что */
  @Column({ type: 'uuid', nullable: true }) productToId: string | null;
  @Column({ type: 'uuid', nullable: true }) unitToId: string | null;
  /** Серийные экземпляры строки */
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) serialItemIds: string[];
  @Column({ type: 'varchar', length: 50, nullable: true }) place: string | null;
  /** reason, acceptedQty, bookQty, countedQty, extraCost … */
  @Column({ type: 'jsonb', default: () => "'{}'" }) extra: Record<string, any>;

  // ── Распределение скидок по строке чека (ТЗ 17.8). Сумма строки amount = price × qty − скидки ± округление.
  @Column({ ...MONEY_COLUMN, default: '0' }) lineDiscount: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) receiptDiscount: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) promoDiscount: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) bonusPaid: Decimal;
  @Column({ ...MONEY_COLUMN, default: '0' }) rounding: Decimal;
  /** Возврат: строка исходной продажи */
  @Column({ type: 'uuid', nullable: true }) sourceLineId: string | null;
}

/** Связь документов: «создан на основании» и автодокументы (ТЗ 9.2). */
@Entity('document_links')
@Index('uq_document_links', ['tenantId', 'fromId', 'toId'], { unique: true })
@Index(['tenantId', 'toId'])
export class DocumentLink extends TenantEntity {
  @Column({ type: 'uuid' }) fromId: string;
  @Column({ type: 'uuid' }) toId: string;
  /** based_on — создан на основании; result — результат (инвентаризация → списание); discrepancy; cost_adjustment */
  @Column({ type: 'varchar', length: 30 }) kind: string;
}

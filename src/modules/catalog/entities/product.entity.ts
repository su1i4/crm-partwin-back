import { Column, Entity, Index } from 'typeorm';
import { Decimal, MONEY_COLUMN, QTY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export const QUALITY_CLASSES = ['original', 'oem', 'aftermarket', 'copy', 'used'] as const;
export type QualityClass = (typeof QUALITY_CLASSES)[number];
export const QUALITY_LABELS: Record<QualityClass, string> = {
  original: 'Оригинал',
  oem: 'OEM (без логотипа)',
  aftermarket: 'Аналог',
  copy: 'Копия (Китай)',
  used: 'Б/у контракт',
};
/** Порядок «лестницы» качества в поиске (ТЗ 5.1). */
export const QUALITY_ORDER: QualityClass[] = ['original', 'oem', 'aftermarket', 'copy', 'used'];

export type ProductKind = 'goods' | 'service' | 'kit';
/** system — служебные позиции кассы («Свободная позиция», «От соседа»): в каталоге и поиске не видны */
export type ProductStatus = 'active' | 'archived' | 'system';
export const BASE_UNITS = ['шт', 'л', 'м', 'кг', 'компл', 'пара'] as const;

/** Карточка товара (ТЗ 4.1). Номер производителя и OEM — в part_numbers, не в атрибутах. */
@Entity('products')
@Index('uq_products_sku', ['tenantId', 'sku'], { unique: true, where: 'deleted_at IS NULL' })
@Index(['tenantId', 'categoryId'])
@Index(['tenantId', 'brandId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'importJobId'])
@Index('ix_products_search_trgm', { synchronize: false }) // GIN (search_text gin_trgm_ops) — в миграции
@Index('ix_products_attributes', { synchronize: false }) // GIN (attributes) — в миграции
export class Product extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 300 })
  name: string;

  /** Внутренний артикул магазина */
  @Column({ type: 'varchar', length: 50 })
  sku: string;

  @Column({ type: 'varchar', length: 10, default: 'goods' })
  kind: ProductKind;

  @Column({ type: 'uuid', nullable: true })
  brandId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'aftermarket' })
  qualityClass: QualityClass;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  @Column({ type: 'uuid', nullable: true })
  partTypeId: string | null;

  /** Значения атрибутов по code: { side: 'Левая', sae: '5W-30', dimensions: [35,52,7] } */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  attributes: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Заметка продавцу — не печатается, клиент не видит */
  @Column({ type: 'text', nullable: true })
  sellerNote: string | null;

  // Гарантия и возврат — null = наследуется от категории
  @Column({ type: 'int', nullable: true })
  warrantyDays: number | null;
  @Column({ type: 'int', nullable: true })
  returnDays: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true })
  returnConditions: string | null;

  /** Базовая единица: шт, л, м, компл, пара. Остаток всегда в ней */
  @Column({ type: 'varchar', length: 10, default: 'шт' })
  baseUnit: string;

  /** Дробное количество (масло на разлив, шланги) и шаг */
  @Column({ default: false })
  fractional: boolean;
  @Column({ ...QTY_COLUMN, default: '1' })
  qtyStep: Decimal;

  /** Серийный учёт: каждый экземпляр отдельно (ТЗ 7.2) */
  @Column({ default: false })
  isSerial: boolean;

  /** Без контроля остатка (ТЗ 4.7) */
  @Column({ default: false })
  noStockControl: boolean;

  /** «Договорная» цена: продавец вводит при продаже (ТЗ 4.7) */
  @Column({ default: false })
  priceNegotiable: boolean;

  /** Минимальная цена продажи (ТЗ 17.5); видна продавцу по долгому нажатию */
  @Column({ ...MONEY_COLUMN, nullable: true })
  minPrice: Decimal | null;

  /** Рекомендованная цена для «договорной» */
  @Column({ ...MONEY_COLUMN, nullable: true })
  recommendedPrice: Decimal | null;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: ProductStatus;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags: string[];

  /** Нормализованный текст для поиска: название, бренд, категория, номера, атрибуты */
  @Column({ type: 'text', default: '' })
  searchText: string;

  /** Объединён в другой товар (дубль, ТЗ 4.8) */
  @Column({ type: 'uuid', nullable: true })
  mergedIntoId: string | null;

  /** Создан импортом — для отката загрузки */
  @Column({ type: 'uuid', nullable: true })
  importJobId: string | null;

  /** Создан быстро при продаже/приёмке — для отчёта «Дозаполнить» */
  @Column({ default: false })
  quickCreated: boolean;
}

/** Единица и упаковка (ТЗ 4.3). Базовая — factor = 1. */
@Entity('product_units')
@Index(['tenantId', 'productId'])
export class ProductUnit extends TenantVersionedEntity {
  @Column({ type: 'uuid' })
  productId: string;

  /** шт, упаковка, коробка, комплект … */
  @Column({ type: 'varchar', length: 30 })
  name: string;

  /** Сколько базовых единиц */
  @Column(QTY_COLUMN)
  factor: Decimal;

  @Column({ default: false })
  isBase: boolean;

  /** computed — цена базовой × коэффициент; own — своя цена */
  @Column({ type: 'varchar', length: 10, default: 'computed' })
  priceMode: 'computed' | 'own';
}

/** Штрихкод привязан к товару и единице (ТЗ 4.4). Один код у нескольких товаров допускается с пометкой. */
@Entity('product_barcodes')
@Index(['tenantId', 'barcode'])
@Index(['tenantId', 'productId'])
@Index('uq_product_barcodes', ['tenantId', 'productId', 'barcode'], { unique: true })
export class ProductBarcode extends TenantEntity {
  @Column({ type: 'uuid' })
  productId: string;

  @Column({ type: 'uuid' })
  unitId: string;

  @Column({ type: 'varchar', length: 64 })
  barcode: string;

  /** Выдан системой (EAN-13 с префиксом 25–29) */
  @Column({ default: false })
  isInternal: boolean;

  /** Сохранён, несмотря на совпадение с другим товаром */
  @Column({ default: false })
  duplicateAccepted: boolean;
}

@Entity('product_photos')
@Index(['tenantId', 'productId'])
export class ProductPhoto extends TenantEntity {
  @Column({ type: 'uuid' })
  productId: string;

  @Column({ type: 'uuid' })
  fileId: string;

  @Column({ type: 'int', default: 0 })
  sort: number;
}

/** Состав комплекта (ТЗ 4.1): «Комплект ТО» = фильтр + масло + прокладка. */
@Entity('kit_components')
@Index('uq_kit_components', ['tenantId', 'kitId', 'componentId'], { unique: true })
export class KitComponent extends TenantEntity {
  @Column({ type: 'uuid' })
  kitId: string;

  @Column({ type: 'uuid' })
  componentId: string;

  @Column(QTY_COLUMN)
  qty: Decimal;
}

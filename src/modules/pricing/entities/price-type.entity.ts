import { Column, Entity, Index } from 'typeorm';
import { COST_COLUMN, Decimal } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export type PriceCurrency = 'KGS' | 'USD';

/** Тип цены (ТЗ 17.1): Розничная, Для СТО, Оптовая + свои. */
@Entity('price_types')
@Index('uq_price_types_tenant_code', ['tenantId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
export class PriceType extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'varchar', length: 3, default: 'KGS' })
  currency: PriceCurrency;

  /** Розничная — цена по умолчанию */
  @Column({ default: false })
  isRetail: boolean;

  @Column({ default: false })
  isSystem: boolean;

  @Column({ type: 'int', default: 0 })
  sort: number;
}

/** Курс магазина (ТЗ 17.2): владелец ставит утром, сразу уходит на все кассы. Текущий — последний. */
@Entity('shop_rates')
@Index(['tenantId', 'currency', 'createdAt'])
export class ShopRate extends TenantEntity {
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency: string;

  /** Сколько сомов за 1 единицу валюты */
  @Column(COST_COLUMN)
  rate: Decimal;

  @Column({ type: 'varchar', length: 200, nullable: true })
  note: string | null;
}

/**
 * Правило наценки (ТЗ 17.4): по категории (с подкатегориями), бренду, классу качества, диапазону закупки.
 * Подходящее правило с наибольшим приоритетом даёт % к себестоимости для типа цены.
 */
@Entity('markup_rules')
@Index(['tenantId', 'priceTypeId'])
export class MarkupRule extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'uuid' }) priceTypeId: string;
  @Column({ type: 'int', default: 0 }) priority: number;
  @Column({ type: 'uuid', nullable: true }) categoryId: string | null;
  @Column({ type: 'uuid', nullable: true }) brandId: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) qualityClass: string | null;
  /** Диапазон закупочной цены за базовую единицу, сом: [from, to) */
  @Column({ ...COST_COLUMN, nullable: true }) costFrom: Decimal | null;
  @Column({ ...COST_COLUMN, nullable: true }) costTo: Decimal | null;
  /** Наценка, % */
  @Column({ type: 'numeric', precision: 9, scale: 3 }) percent: string;
  @Column({ default: true }) isActive: boolean;
}

/** Документ «Установка цен» (ТЗ 17.4): предпросмотр, дата начала действия, история. */
@Entity('price_settings')
@Index('uq_price_settings_number', ['tenantId', 'number'], { unique: true })
export class PriceSetting extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 40 }) number: string;
  @Column({ type: 'varchar', length: 20, default: 'draft' }) status: 'draft' | 'posted';
  @Column({ type: 'timestamptz' }) validFrom: Date;
  @Column({ type: 'text', nullable: true }) comment: string | null;
  @Column({ type: 'timestamptz', nullable: true }) postedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) postedBy: string | null;
}

@Entity('price_setting_lines')
@Index(['tenantId', 'priceSettingId'])
export class PriceSettingLine extends TenantEntity {
  @Column({ type: 'uuid' }) priceSettingId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'uuid' }) priceTypeId: string;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) unitId: string | null;
  @Column({ ...COST_COLUMN, nullable: true }) oldPrice: Decimal | null;
  @Column(COST_COLUMN) newPrice: Decimal;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  /** manual | markup | from_type */
  @Column({ type: 'varchar', length: 20, default: 'manual' }) method: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) extra: Record<string, any>;
}

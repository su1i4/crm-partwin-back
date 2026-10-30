import { Column, Entity, Index } from 'typeorm';
import { Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity } from '../../../database/tenant/base.entity';

/**
 * Цена (ТЗ 17, модель данных 26): тип цены × точка (null — все точки) × товар × единица (null — базовая).
 * Действующая — последняя с valid_from ≤ now. История — все строки.
 */
@Entity('prices')
@Index(['tenantId', 'productId', 'priceTypeId', 'validFrom'])
export class Price extends TenantEntity {
  @Column({ type: 'uuid' })
  priceTypeId: string;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  @Column({ type: 'uuid' })
  productId: string;

  @Column({ type: 'uuid', nullable: true })
  unitId: string | null;

  @Column(MONEY_COLUMN)
  price: Decimal;

  @Column({ type: 'varchar', length: 3, default: 'KGS' })
  currency: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  validFrom: Date;

  /** Документ «Установка цен» (этап 3.1) */
  @Column({ type: 'uuid', nullable: true })
  documentId: string | null;
}

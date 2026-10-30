import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

export type PartNumberType = 'manufacturer' | 'oem' | 'supplier';

/**
 * Номера деталей (ТЗ 4.2): производитель + бренд (уникальна пара в магазине), OEM (может быть у многих товаров),
 * коды поставщиков. normalized — для точного поиска, skeleton — для путаницы 0/O, 1/I, 5/S, 8/B, 2/Z.
 */
@Entity('part_numbers')
@Index(['tenantId', 'normalized'])
@Index(['tenantId', 'skeleton'])
@Index(['tenantId', 'productId'])
@Index('uq_part_numbers_manufacturer', ['tenantId', 'brandId', 'normalized'], {
  unique: true,
  where: `type = 'manufacturer'`,
})
@Index('ix_part_numbers_trgm', { synchronize: false }) // GIN (normalized gin_trgm_ops) — в миграции
@Index('ix_part_numbers_prefix', { synchronize: false }) // (tenant_id, normalized COLLATE "C") — поиск по началу номера
export class PartNumber extends TenantEntity {
  @Column({ type: 'uuid' })
  productId: string;

  @Column({ type: 'uuid', nullable: true })
  brandId: string | null;

  /** Как ввели: «0 986-452.041» */
  @Column({ type: 'varchar', length: 80 })
  number: string;

  /** 0986452041 */
  @Column({ type: 'varchar', length: 80 })
  normalized: string;

  @Column({ type: 'varchar', length: 80 })
  skeleton: string;

  @Column({ type: 'varchar', length: 15 })
  type: PartNumberType;

  /** Для кода поставщика — контрагент (этап 4) */
  @Column({ type: 'uuid', nullable: true })
  supplierId: string | null;
}

export type CrossType = 'full' | 'partial' | 'oem_replacement';
export type CrossSource = 'manual' | 'pricelist' | 'import';

/**
 * Аналог (кросс): связь «номер ↔ номер» (ТЗ 4.2). Бренд стороны может быть не задан — тогда любой бренд с этим номером.
 * Для oem_replacement сторона A — оригинал.
 */
@Entity('part_crosses')
@Index(['tenantId', 'aNormalized'])
@Index(['tenantId', 'bNormalized'])
@Index('uq_part_crosses_pair', ['tenantId', 'aNormalized', 'aBrandKey', 'bNormalized', 'bBrandKey'], { unique: true })
export class PartCross extends TenantEntity {
  @Column({ type: 'uuid', nullable: true })
  aBrandId: string | null;
  @Column({ type: 'varchar', length: 80 })
  aNumber: string;
  @Column({ type: 'varchar', length: 80 })
  aNormalized: string;
  /** brand_id или '' — для уникальности пары */
  @Column({ type: 'varchar', length: 36, default: '' })
  aBrandKey: string;

  @Column({ type: 'uuid', nullable: true })
  bBrandId: string | null;
  @Column({ type: 'varchar', length: 80 })
  bNumber: string;
  @Column({ type: 'varchar', length: 80 })
  bNormalized: string;
  @Column({ type: 'varchar', length: 36, default: '' })
  bBrandKey: string;

  @Column({ type: 'varchar', length: 20, default: 'full' })
  crossType: CrossType;

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  source: CrossSource;

  /** Откуда: id импорта или прайса */
  @Column({ type: 'uuid', nullable: true })
  sourceRefId: string | null;
}

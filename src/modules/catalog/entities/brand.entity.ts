import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/**
 * Бренд — общий справочник платформы (ТЗ 4.2). Синонимы — в aliases:
 * MB = Mercedes-Benz, Toyota Genuine = Toyota, TRW Automotive = TRW.
 */
@Entity('global_brands')
@Index('uq_global_brands_norm', ['normalizedName'], { unique: true })
@Index('ix_global_brands_aliases', { synchronize: false }) // GIN — создаётся в миграции
export class GlobalBrand extends PlatformEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 100 })
  normalizedName: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliases: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliasesNorm: string[];

  @Column({ type: 'varchar', length: 60, nullable: true })
  country: string | null;

  /** Бренд автопроизводителя (оригинальные запчасти) */
  @Column({ default: false })
  isCarMaker: boolean;

  /** Системный «Без бренда» */
  @Column({ default: false })
  isNoBrand: boolean;
}

/** Бренд магазина: свой или «подключённый» глобальный (global_brand_id). */
@Entity('brands')
@Index('uq_brands_norm', ['tenantId', 'normalizedName'], { unique: true, where: 'deleted_at IS NULL' })
@Index('ix_brands_aliases', { synchronize: false }) // GIN — в миграции
@Index('uq_brands_global', ['tenantId', 'globalBrandId'], {
  unique: true,
  where: 'deleted_at IS NULL AND global_brand_id IS NOT NULL',
})
export class Brand extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 100 })
  normalizedName: string;

  @Column({ type: 'uuid', nullable: true })
  globalBrandId: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliases: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  aliasesNorm: string[];

  @Column({ type: 'varchar', length: 60, nullable: true })
  country: string | null;

  @Column({ default: false })
  isCarMaker: boolean;

  @Column({ default: false })
  isNoBrand: boolean;
}

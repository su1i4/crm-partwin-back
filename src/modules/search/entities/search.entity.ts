import { Column, Entity, Index } from 'typeorm';
import { PlatformEntity, TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Базовый словарь сленга и синонимов (ТЗ 5.5): «граната» → «шрус». */
@Entity('global_search_synonyms')
@Index('uq_global_search_synonyms', ['word', 'target'], { unique: true })
export class GlobalSearchSynonym extends PlatformEntity {
  /** Что пишут (нормализовано: нижний регистр, ё→е) */
  @Column({ type: 'varchar', length: 100 }) word: string;
  /** Что искать */
  @Column({ type: 'varchar', length: 200 }) target: string;
  @Column({ type: 'varchar', length: 5, default: 'ru' }) lang: string;
}

/** Синонимы магазина поверх базового словаря. */
@Entity('search_synonyms')
@Index('uq_search_synonyms', ['tenantId', 'word', 'target'], { unique: true, where: 'deleted_at IS NULL' })
export class SearchSynonym extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 100 }) word: string;
  @Column({ type: 'varchar', length: 200 }) target: string;
}

/** Ненайденные запросы (ТЗ 5.4) — отчёт «Что спрашивают, но нет». */
@Entity('unfound_queries')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'normalized'])
export class UnfoundQuery extends TenantEntity {
  @Column({ type: 'varchar', length: 300 }) query: string;
  @Column({ type: 'varchar', length: 300 }) normalized: string;
  /** none — ничего не нашли; no_stock — нашли, но нет в наличии */
  @Column({ type: 'varchar', length: 10 }) reason: 'none' | 'no_stock' | 'request';
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) makeId: string | null;
  @Column({ type: 'uuid', nullable: true }) modelId: string | null;
  @Column({ type: 'uuid', nullable: true }) generationId: string | null;
  /** cash | catalog | document | global */
  @Column({ type: 'varchar', length: 20, nullable: true }) context: string | null;
}

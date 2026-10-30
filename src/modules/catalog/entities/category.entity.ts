import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Правила, наследуемые товарами категории (ТЗ 4.1, 4.3, 4.7, 7.4, 15.1). */
export interface CategorySettings {
  warrantyDays?: number | null;
  returnDays?: number | null;
  returnConditions?: string | null;
  /** «Обычно берут парой» — подсказка на кассе */
  pairHint?: boolean;
  /** Переопределение продажи в минус для категории */
  negativeStock?: 'forbid' | 'warn' | null;
  /** Без контроля остатка по умолчанию для товаров категории */
  noStockControl?: boolean;
  /** Позиции «не подошло» требуют отметок без следов установки */
  requireNoInstallMarks?: boolean;
  /** Универсальные товары без привязки к авто (масла, химия, лампы, инструмент) — ветка «Универсальное» (ТЗ 6.3) */
  universal?: boolean;
}

/** Дерево групп деталей (ТЗ 4.6). path — цепочка id предков: /a/b/ */
@Entity('categories')
@Index(['tenantId', 'parentId'])
@Index('uq_categories_name_in_parent', ['tenantId', 'parentId', 'name'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
export class Category extends TenantVersionedEntity {
  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 2000, default: '/' })
  path: string;

  @Column({ type: 'smallint', default: 0 })
  level: number;

  @Column({ type: 'int', default: 0 })
  sort: number;

  /** Код из пресета — чтобы повторный запуск мастера не создавал дубли */
  @Column({ type: 'varchar', length: 80, nullable: true })
  presetCode: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  settings: CategorySettings;
}

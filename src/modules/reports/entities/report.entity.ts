import { Column, Entity, Index } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity } from '../../../database/tenant/base.entity';

/**
 * Отчётная таблица продаж (ТЗ 20): день × точка × продавец × клиент × товар.
 * Пересчитывается по событию проведения чека/возврата и ночью; на ней — отчёты продаж и прибыли.
 */
@Entity('rpt_sales_daily')
@Index(['tenantId', 'day', 'storeId'])
@Index(['tenantId', 'productId', 'day'])
export class RptSalesDaily extends TenantEntity {
  @Column({ type: 'date' }) day: string;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) sellerId: string | null;
  @Column({ type: 'uuid', nullable: true }) customerId: string | null;
  @Column({ type: 'uuid' }) productId: string;
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 }) qty: string;
  @Column({ ...MONEY_COLUMN, default: 0 }) revenue: Decimal;
  @Column({ ...COST_COLUMN, default: 0 }) cost: Decimal;
  @Column({ ...MONEY_COLUMN, default: 0 }) discount: Decimal;
  @Column({ type: 'numeric', precision: 18, scale: 3, default: 0 }) returnedQty: string;
  @Column({ ...MONEY_COLUMN, default: 0 }) returnedAmount: Decimal;
}

/** Сохранённый вид отчёта: фильтры и группировка (ТЗ 20). */
@Entity('report_views')
@Index(['tenantId', 'userId'])
export class ReportView extends TenantEntity {
  @Column({ type: 'uuid' }) userId: string;
  @Column({ type: 'varchar', length: 60 }) report: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'jsonb', default: () => "'{}'" }) params: Record<string, unknown>;
  @Column({ default: false }) shared: boolean;
}

/** Вечерняя сводка владельцу (ТЗ 20.3): что и когда отправлено. */
@Entity('owner_summaries')
@Index(['tenantId', 'day'], { unique: true })
export class OwnerSummary extends TenantEntity {
  @Column({ type: 'date' }) day: string;
  @Column({ type: 'jsonb' }) data: Record<string, unknown>;
  @Column({ type: 'int', default: 0 }) sentTo: number;
}

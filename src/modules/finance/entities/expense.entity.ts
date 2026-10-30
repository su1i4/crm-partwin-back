import { Column, Entity, Index } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { PlatformEntity, TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/**
 * Статья расходов (ТЗ 19.2). kind: expense — расход бизнеса; salary — зарплата (мотивация 19.7);
 * owner — изъятие собственника: не расход, в прибыль не входит, отдельной строкой.
 */
export type ExpenseArticleKind = 'expense' | 'salary' | 'owner';

@Entity('expense_articles')
@Index(['tenantId', 'code'], { unique: true })
export class ExpenseArticle extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'varchar', length: 10, default: 'expense' }) kind: ExpenseArticleKind;
  @Column({ default: false }) isSystem: boolean;
  @Column({ default: true }) isActive: boolean;
}

/** Расход или изъятие: деньги ушли со счёта по статье. Отмена — сторно, запись остаётся. */
@Entity('expenses')
@Index(['tenantId', 'expenseDate'])
export class Expense extends TenantEntity {
  @Column({ type: 'uuid' }) articleId: string;
  @Column({ type: 'uuid' }) accountId: string;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(MONEY_COLUMN) amount: Decimal;
  @Column(MONEY_COLUMN) amountKgs: Decimal;
  @Column({ type: 'date' }) expenseDate: string;
  /** Кому: поставщик услуги / арендодатель */
  @Column({ type: 'uuid', nullable: true }) counterpartyId: string | null;
  /** Зарплата: сотрудник */
  @Column({ type: 'uuid', nullable: true }) membershipId: string | null;
  @Column({ type: 'uuid', nullable: true }) recurringId: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
  @Column({ type: 'varchar', length: 10, default: 'posted' }) status: 'posted' | 'cancelled';
  @Column({ type: 'timestamptz', nullable: true }) cancelledAt: Date | null;
}

/** Регулярный расход: аренда 1-го числа, интернет 10-го — создаётся сам (ТЗ 19.2). */
@Entity('recurring_expenses')
export class RecurringExpense extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) articleId: string;
  @Column({ type: 'uuid' }) accountId: string;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column(MONEY_COLUMN) amount: Decimal;
  @Column({ type: 'uuid', nullable: true }) counterpartyId: string | null;
  @Column({ type: 'smallint' }) dayOfMonth: number;
  @Column({ type: 'date' }) nextDate: string;
  @Column({ type: 'varchar', length: 300, nullable: true }) comment: string | null;
  @Column({ default: true }) isActive: boolean;
  @Column({ type: 'timestamptz', nullable: true }) lastRunAt: Date | null;
}

/** Переоценка валютного долга на конец месяца по курсу НБКР (ТЗ 19.5). */
@Entity('fx_revaluations')
@Index(['tenantId', 'month'])
export class FxRevaluation extends TenantEntity {
  /** YYYY-MM */
  @Column({ type: 'varchar', length: 7 }) month: string;
  @Column({ type: 'uuid' }) debtItemId: string;
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'varchar', length: 10 }) direction: string;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(MONEY_COLUMN) remaining: Decimal;
  @Column(COST_COLUMN) rateFrom: Decimal;
  @Column(COST_COLUMN) rateTo: Decimal;
  /** + доход, − убыток */
  @Column(MONEY_COLUMN) diffKgs: Decimal;
}

/** Мотивация продавца (ТЗ 19.7): оклад + % от продаж или маржи, план на месяц. */
@Entity('salary_rules')
@Index(['tenantId', 'membershipId'], { unique: true })
export class SalaryRule extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) membershipId: string;
  @Column({ ...MONEY_COLUMN, default: 0 }) baseMonthly: Decimal;
  @Column({ type: 'numeric', precision: 6, scale: 3, default: 0 }) percent: string;
  @Column({ type: 'varchar', length: 10, default: 'sales' }) basis: 'sales' | 'margin';
  @Column({ ...MONEY_COLUMN, nullable: true }) planMonthly: Decimal | null;
}

/** Курс НБКР на дату (общий для платформы). На выходные — последний опубликованный. */
@Entity('nbkr_rates')
@Index(['rateDate', 'currency'], { unique: true })
export class NbkrRate extends PlatformEntity {
  @Column({ type: 'date' }) rateDate: string;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(COST_COLUMN) rate: Decimal;
}

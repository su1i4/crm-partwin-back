import { Column, Entity, Generated, Index, JoinColumn, ManyToOne } from 'typeorm';
import { COST_COLUMN, Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';
import { Counterparty } from '../../counterparties/entities/counterparty.entity';
import { Register } from '../../stores/entities/register.entity';
import { MoneyAccount } from './money-account.entity';

/**
 * Вид движения денег (ТЗ 19.2):
 * sale / refund — оплата чека и возврат; debt_in / debt_out — оплата долга клиентом / нами;
 * cash_in / cash_out — внесение и изъятие; transfer — перемещение между счетами (две записи);
 * exchange — обмен валюты (две записи); fee — комиссия эквайринга; shift_diff — расхождение смены;
 * not_received — перевод не поступил (сторно); expense — расход по статье (operation_id = id расхода); owner_withdrawal — изъятие собственника.
 */
export const MONEY_KINDS = [
  'sale', 'refund', 'debt_in', 'debt_out', 'cash_in', 'cash_out', 'transfer', 'exchange', 'fee', 'shift_diff', 'not_received', 'expense', 'owner_withdrawal',
] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

export type VerifyStatus = 'unverified' | 'verified' | 'not_received';

/** Регистр денег: каждая запись — приход (+) или расход (−) по счёту в его валюте. Остаток = сумма. */
@Entity('money_movements')
@Index(['tenantId', 'accountId', 'movedAt'])
@Index(['tenantId', 'shiftId'])
@Index(['tenantId', 'documentId'])
@Index(['tenantId', 'verifyStatus', 'movedAt'])
export class MoneyMovement extends TenantEntity {
  @Column({ type: 'uuid' }) accountId: string;
  @ManyToOne(() => MoneyAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'account_id' })
  account?: MoneyAccount;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(MONEY_COLUMN) amount: Decimal;
  /** Сумма в сомах по курсу на момент движения */
  @Column(MONEY_COLUMN) amountKgs: Decimal;
  @Column({ type: 'varchar', length: 20 }) kind: MoneyKind;
  @Column({ type: 'timestamptz' }) movedAt: Date;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column({ type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'uuid', nullable: true }) operationId: string | null;
  @Column({ type: 'uuid', nullable: true }) debtPaymentId: string | null;
  @Column({ type: 'uuid', nullable: true }) counterpartyId: string | null;
  /** Кто принял / выдал деньги (участник магазина) */
  @Column({ type: 'uuid', nullable: true }) membershipId: string | null;
  /** Переводы на кошелёк — сверка (ТЗ 19.3) */
  @Column({ type: 'varchar', length: 15, nullable: true }) verifyStatus: VerifyStatus | null;
  @Column({ type: 'timestamptz', nullable: true }) verifiedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) verifiedBy: string | null;
  /** Скриншот перевода */
  @Column({ type: 'uuid', nullable: true }) fileId: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
  @Column({ type: 'bigint' }) @Generated('increment') seq: string;
}

export const MONEY_OPERATION_TYPES = ['cash_in', 'cash_out', 'transfer', 'exchange'] as const;
export type MoneyOperationType = (typeof MONEY_OPERATION_TYPES)[number];

/** Операция с деньгами вне чека: внесение, изъятие (куда: сейф, владельцу, банк), перемещение, обмен валюты. */
@Entity('money_operations')
@Index(['tenantId', 'shiftId'])
@Index(['tenantId', 'createdAt'])
export class MoneyOperation extends TenantEntity {
  @Column({ type: 'varchar', length: 20 }) type: MoneyOperationType;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'uuid', nullable: true }) fromAccountId: string | null;
  @Column({ type: 'uuid', nullable: true }) toAccountId: string | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) amount: Decimal | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) toAmount: Decimal | null;
  /** Обмен: фактический курс и курс магазина на момент обмена */
  @Column({ ...COST_COLUMN, nullable: true }) rate: Decimal | null;
  @Column({ ...COST_COLUMN, nullable: true }) shopRate: Decimal | null;
  /** Изъятие: safe | owner | bank | other */
  @Column({ type: 'varchar', length: 20, nullable: true }) purpose: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
  @Column({ type: 'uuid', nullable: true }) membershipId: string | null;
}

export type ShiftStatus = 'open' | 'closed';
export type CashByCurrency = Record<string, string>;

/** Кассовая смена (ТЗ 13.7). На кассе одновременно одна открытая смена. */
@Entity('shifts')
@Index('uq_shifts_open', ['tenantId', 'registerId'], { unique: true, where: `status = 'open'` })
@Index(['tenantId', 'registerId', 'number'])
@Index(['tenantId', 'storeId', 'openedAt'])
export class Shift extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) registerId: string;
  @ManyToOne(() => Register, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'register_id' })
  register?: Register;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'int' }) number: number;
  @Column({ type: 'varchar', length: 10, default: 'open' }) status: ShiftStatus;
  @Column({ type: 'timestamptz' }) openedAt: Date;
  @Column({ type: 'uuid' }) openedBy: string;
  /** Наличные при открытии по валютам, как пересчитали */
  @Column({ type: 'jsonb', default: () => "'{}'" }) opening: CashByCurrency;
  /** Расхождение при открытии (пересчёт ≠ остаток счёта) */
  @Column({ type: 'jsonb', default: () => "'{}'" }) openingDiff: CashByCurrency;
  /** Текущий продавец кассы (передача кассы) */
  @Column({ type: 'uuid' }) currentMembershipId: string;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) closedBy: string | null;
  @Column({ type: 'jsonb', nullable: true }) counted: CashByCurrency | null;
  @Column({ type: 'jsonb', nullable: true }) expected: CashByCurrency | null;
  @Column({ type: 'jsonb', nullable: true }) diff: CashByCurrency | null;
  @Column({ default: false }) autoClosed: boolean;
  /** Смена, открытая на кассе без интернета: UUID с устройства */
  @Column({ type: 'uuid', nullable: true }) clientId: string | null;
  /** Z-отчёт, сохранённый при закрытии */
  @Column({ type: 'jsonb', nullable: true }) zReport: Record<string, any> | null;
}

/** Передача кассы между продавцами с пересчётом наличных. */
@Entity('shift_handovers')
@Index(['tenantId', 'shiftId'])
export class ShiftHandover extends TenantEntity {
  @Column({ type: 'uuid' }) shiftId: string;
  @Column({ type: 'uuid' }) fromMembershipId: string;
  @Column({ type: 'uuid' }) toMembershipId: string;
  @Column({ type: 'jsonb' }) counted: CashByCurrency;
  @Column({ type: 'jsonb' }) expected: CashByCurrency;
  @Column({ type: 'jsonb' }) diff: CashByCurrency;
}

// ── Долги и взаиморасчёты (ТЗ 18.2, 19.5) ──────────────────

/** receivable — нам должны; payable — мы должны (соседу, поставщику, аванс клиента) */
export type DebtDirection = 'receivable' | 'payable';
/** sale — продажа в долг; neighbor — взяли у соседа; advance — аванс/переплата; not_received — перевод не пришёл; manual — ввод остатка */
/** prepayment — предоплата по заявке (не гасит другие долги сама) */
export type DebtKind = 'sale' | 'neighbor' | 'advance' | 'prepayment' | 'not_received' | 'manual' | 'purchase' | 'purchase_return' | 'extra_costs' | 'master_bonus' | 'consignment';

/** Открытая позиция долга: остаток гасится оплатами и зачётами. */
@Entity('debt_items')
@Index(['tenantId', 'counterpartyId', 'direction', 'openedAt'])
@Index(['tenantId', 'documentId'])
@Index(['tenantId', 'customerVehicleId'])
export class DebtItem extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @ManyToOne(() => Counterparty, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'counterparty_id' })
  counterparty?: Counterparty;
  @Column({ type: 'varchar', length: 10 }) direction: DebtDirection;
  @Column({ type: 'varchar', length: 15 }) kind: DebtKind;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
  @Column(MONEY_COLUMN) amount: Decimal;
  @Column(MONEY_COLUMN) remaining: Decimal;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column({ type: 'uuid', nullable: true }) customerVehicleId: string | null;
  /** Госномер / заказ-наряд СТО, если машины нет в гараже */
  @Column({ type: 'varchar', length: 60, nullable: true }) vehicleLabel: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) description: string | null;
  @Column({ type: 'timestamptz' }) openedAt: Date;
  @Column({ type: 'date', nullable: true }) dueDate: string | null;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
}

/** Оплата долга (клиент заплатил / мы заплатили соседу) или взаимозачёт. */
@Entity('debt_payments')
@Index(['tenantId', 'counterpartyId', 'createdAt'])
export class DebtPayment extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  /** in — нам заплатили; out — мы заплатили; offset — взаимозачёт */
  @Column({ type: 'varchar', length: 10 }) direction: 'in' | 'out' | 'offset';
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column(MONEY_COLUMN) amount: Decimal;
  @Column({ type: 'uuid', nullable: true }) accountId: string | null;
  /** Валюта счёта ≠ валюте долга: сумма по счёту и курс */
  @Column({ ...MONEY_COLUMN, nullable: true }) accountAmount: Decimal | null;
  @Column({ ...COST_COLUMN, nullable: true }) rate: Decimal | null;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true }) idempotencyKey: string | null;
}

/** Распределение: какая оплата (или встречная позиция) какую позицию долга погасила. */
@Entity('debt_allocations')
@Index(['tenantId', 'debtItemId'])
@Index(['tenantId', 'paymentId'])
export class DebtAllocation extends TenantEntity {
  @Column({ type: 'uuid' }) debtItemId: string;
  @ManyToOne(() => DebtItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'debt_item_id' })
  debtItem?: DebtItem;
  @Column({ type: 'uuid', nullable: true }) paymentId: string | null;
  /** Зачёт встречной позицией (аванс → долг, долг соседу ↔ его долг нам) */
  @Column({ type: 'uuid', nullable: true }) offsetItemId: string | null;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column(MONEY_COLUMN) amount: Decimal;
}

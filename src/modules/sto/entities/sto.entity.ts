import { Column, Entity, Index } from 'typeorm';
import { Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export interface SelectionLine {
  productId: string;
  qty: string;
  /** Закрытие: сколько подошло (продано) */
  soldQty?: string;
}

/** Выдача СТО «на подбор» (ТЗ 14.5): товар на складе «У клиента», срок, закрытие продажей и возвратом. */
@Entity('selection_issues')
@Index(['tenantId', 'status'])
export class SelectionIssue extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 30 }) number: string;
  @Column({ type: 'uuid' }) storeId: string;
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'uuid', nullable: true }) customerVehicleId: string | null;
  @Column({ type: 'uuid' }) warehouseId: string;
  @Column({ type: 'uuid' }) customerWarehouseId: string;
  @Column({ type: 'uuid' }) issueDocumentId: string;
  @Column({ type: 'uuid', nullable: true }) returnDocumentId: string | null;
  @Column({ type: 'uuid', nullable: true }) receiptId: string | null;
  @Column({ type: 'jsonb' }) lines: SelectionLine[];
  @Column({ type: 'date' }) dueDate: string;
  @Column({ type: 'varchar', length: 10, default: 'open' }) status: 'open' | 'closed';
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) remindedAt: Date | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) comment: string | null;
}

/** Правило бонуса мастеру (ТЗ 14.7): % от суммы или маржи либо фикс; для мастера, группы или общее. */
@Entity('master_bonus_rules')
export class MasterBonusRule extends TenantVersionedEntity {
  @Column({ type: 'uuid', nullable: true }) masterId: string | null;
  @Column({ type: 'uuid', nullable: true }) categoryId: string | null;
  @Column({ type: 'varchar', length: 15 }) kind: 'percent_sales' | 'percent_margin' | 'fixed';
  @Column({ type: 'numeric', precision: 12, scale: 2 }) value: string;
  @Column({ default: true }) isActive: boolean;
}

/** Начисленный бонус мастеру за чек — долг магазина перед мастером. */
@Entity('master_bonuses')
@Index(['tenantId', 'receiptId'], { unique: true })
export class MasterBonus extends TenantEntity {
  @Column({ type: 'uuid' }) masterId: string;
  @Column({ type: 'uuid' }) receiptId: string;
  @Column(MONEY_COLUMN) amount: Decimal;
  @Column({ type: 'uuid', nullable: true }) debtItemId: string | null;
}

/** Персональная цена «клиент × товар» (ТЗ 14.8), за базовую единицу. */
@Entity('personal_prices')
@Index(['tenantId', 'counterpartyId', 'productId'], { unique: true })
export class PersonalPrice extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'uuid' }) productId: string;
  @Column(MONEY_COLUMN) price: Decimal;
  @Column({ type: 'varchar', length: 3, default: 'KGS' }) currency: string;
}

/** Задача (ТЗ 18.3): исполнитель, срок, напоминание; привязка к клиенту, машине, заявке, документу. */
@Entity('tasks')
@Index(['tenantId', 'status', 'dueAt'])
@Index(['tenantId', 'autoKey'], { unique: true, where: 'auto_key IS NOT NULL' })
export class Task extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 300 }) title: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'uuid', nullable: true }) assigneeId: string | null;
  @Column({ type: 'uuid', nullable: true }) storeId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) dueAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) remindAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) remindedAt: Date | null;
  @Column({ type: 'varchar', length: 10, default: 'open' }) status: 'open' | 'done' | 'cancelled';
  @Column({ type: 'uuid', nullable: true }) counterpartyId: string | null;
  @Column({ type: 'uuid', nullable: true }) customerVehicleId: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) entityType: string | null;
  @Column({ type: 'uuid', nullable: true }) entityId: string | null;
  /** Автозадача: oil_change, order_not_picked, selection_overdue, debt_overdue, fit_check */
  @Column({ type: 'varchar', length: 30, nullable: true }) autoKind: string | null;
  /** Ключ, чтобы автозадача не создалась дважды */
  @Column({ type: 'varchar', length: 120, nullable: true }) autoKey: string | null;
  @Column({ type: 'timestamptz', nullable: true }) doneAt: Date | null;
}

/** Лента по клиенту: звонки и заметки вручную (покупки и заявки подтягиваются сами). */
@Entity('customer_activities')
@Index(['tenantId', 'counterpartyId', 'createdAt'])
export class CustomerActivity extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'varchar', length: 10 }) kind: 'call' | 'note' | 'message';
  @Column({ type: 'text' }) text: string;
}

/** Шаблон сообщения клиенту с переменными {имя}, {номер_заявки}, {сумма} — на русском и кыргызском. */
@Entity('message_templates')
@Index(['tenantId', 'code'], { unique: true })
export class MessageTemplate extends TenantEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'text' }) textRu: string;
  @Column({ type: 'text', nullable: true }) textKy: string | null;
}

/** Правило автозадачи «замена масла»: через N месяцев после покупки товаров группы. */
@Entity('oil_reminder_rules')
export class OilReminderRule extends TenantEntity {
  @Column({ type: 'uuid', nullable: true }) categoryId: string | null;
  @Column({ type: 'smallint', default: 6 }) months: number;
  @Column({ default: true }) isActive: boolean;
}

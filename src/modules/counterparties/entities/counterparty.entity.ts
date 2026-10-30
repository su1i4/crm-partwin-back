import { Column, Entity, Index } from 'typeorm';
import { Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export const COUNTERPARTY_ROLES = ['customer', 'sto', 'master', 'supplier', 'neighbor', 'consignee'] as const;
export type CounterpartyRole = (typeof COUNTERPARTY_ROLES)[number];

/**
 * Контрагент — один справочник с ролями (ТЗ 18.1): клиент, СТО, мастер, поставщик, сосед, реализатор.
 * Тип цены, скидка, лимит и срок долга — свои или из группы (null = из группы).
 */
@Entity('counterparties')
@Index(['tenantId', 'phone'])
@Index('ix_counterparties_roles', { synchronize: false }) // GIN (roles) — в миграции
export class Counterparty extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 10, default: 'person' }) kind: 'person' | 'company';
  /** Нормализованный основной телефон */
  @Column({ type: 'varchar', length: 20, nullable: true }) phone: string | null;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) phones: string[];
  @Column({ type: 'varchar', length: 20, nullable: true }) inn: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) address: string | null;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) roles: CounterpartyRole[];
  @Column({ type: 'jsonb', default: () => "'{}'" }) messengers: Record<string, string>;
  /** Поставщик: валюта, отсрочка, срок поставки, мин. партия */
  @Column({ type: 'jsonb', default: () => "'{}'" }) supplierTerms: Record<string, any>;
  @Column({ type: 'text', nullable: true }) note: string | null;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) tags: string[];
  @Column({ type: 'uuid', nullable: true }) groupId: string | null;
  @Column({ type: 'date', nullable: true }) birthday: string | null;
  @Column({ type: 'uuid', nullable: true }) priceTypeId: string | null;
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true }) discountPercent: string | null;
  @Column({ ...MONEY_COLUMN, nullable: true }) debtLimit: Decimal | null;
  @Column({ type: 'int', nullable: true }) debtDays: number | null;
  /** Объединён в другого контрагента (дубль) */
  @Column({ type: 'uuid', nullable: true }) mergedIntoId: string | null;
}

/** Группа клиентов (ТЗ 18.1): Розница, СТО, Таксопарки, Оптовики, Мастера → тип цены, скидка, лимит и срок долга. */
@Entity('counterparty_groups')
@Index('uq_counterparty_groups_name', ['tenantId', 'name'], { unique: true, where: 'deleted_at IS NULL' })
export class CounterpartyGroup extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 100 }) name: string;
  @Column({ type: 'uuid', nullable: true }) priceTypeId: string | null;
  @Column({ type: 'numeric', precision: 5, scale: 2, default: '0' }) discountPercent: string;
  /** null — без лимита; 0 — в долг нельзя */
  @Column({ ...MONEY_COLUMN, nullable: true }) debtLimit: Decimal | null;
  /** Срок долга, дней (null — бессрочно) */
  @Column({ type: 'int', nullable: true }) debtDays: number | null;
  @Column({ type: 'int', default: 0 }) sort: number;
}

/** Контактное лицо организации. */
@Entity('counterparty_contacts')
@Index(['tenantId', 'counterpartyId'])
export class CounterpartyContact extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) position: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) phone: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) note: string | null;
}

/** Машина клиента — гараж (ТЗ 6.4). */
@Entity('customer_vehicles')
@Index(['tenantId', 'counterpartyId'])
@Index(['tenantId', 'plate'])
export class CustomerVehicle extends TenantVersionedEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'uuid', nullable: true }) makeId: string | null;
  @Column({ type: 'uuid', nullable: true }) modelId: string | null;
  @Column({ type: 'uuid', nullable: true }) generationId: string | null;
  @Column({ type: 'uuid', nullable: true }) modificationId: string | null;
  /** Подпись для списков и чека: «Toyota Camry 40 2009» */
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 17, nullable: true }) vin: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) bodyCode: string | null;
  @Column({ type: 'smallint', nullable: true }) year: number | null;
  /** Госномер без пробелов, верхний регистр: 01KG123ABC */
  @Column({ type: 'varchar', length: 20, nullable: true }) plate: string | null;
  @Column({ type: 'int', nullable: true }) mileage: number | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) note: string | null;
}


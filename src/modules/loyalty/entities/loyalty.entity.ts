import { Column, Entity, Index } from 'typeorm';
import { Decimal, MONEY_COLUMN } from '../../../common/utils/decimal';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Акция (ТЗ 17.6): период, точки, на что; несуммируемые — лучшая для покупателя. */
@Entity('promotions')
export class Promotion extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 150 }) name: string;
  @Column({ type: 'varchar', length: 20 }) kind: 'percent' | 'receipt_amount' | 'second_item';
  @Column({ type: 'numeric', precision: 5, scale: 2 }) percent: string;
  @Column({ ...MONEY_COLUMN, nullable: true }) minAmount: Decimal | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) categoryIds: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) brandIds: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) qualityClasses: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) makeIds: string[];
  @Column({ type: 'jsonb', default: () => "'[]'" }) productIds: string[];
  /** Пусто — все точки */
  @Column({ type: 'jsonb', default: () => "'[]'" }) storeIds: string[];
  @Column({ type: 'date', nullable: true }) startsOn: string | null;
  @Column({ type: 'date', nullable: true }) endsOn: string | null;
  @Column({ default: false }) stackable: boolean;
  /** Действует только по промокоду */
  @Column({ default: false }) byCode: boolean;
  @Column({ default: true }) isActive: boolean;
}

/** Промокод: одноразовый или многоразовый, лимит использований. */
@Entity('promo_codes')
@Index(['tenantId', 'code'], { unique: true })
export class PromoCode extends TenantEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'uuid' }) promotionId: string;
  @Column({ type: 'int', nullable: true }) maxUses: number | null;
  @Column({ type: 'int', default: 0 }) usedCount: number;
  @Column({ default: true }) isActive: boolean;
}

/** Карта клиента (ТЗ 17.7): номер, QR/штрихкод; виртуальная — в Telegram. */
@Entity('loyalty_cards')
@Index(['tenantId', 'number'], { unique: true })
@Index(['tenantId', 'counterpartyId'], { unique: true })
export class LoyaltyCard extends TenantEntity {
  @Column({ type: 'varchar', length: 20 }) number: string;
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ default: true }) isActive: boolean;
}

/**
 * Движение бонусов: начисление (+, со сроком сгорания и остатком для списания по очереди), списание (−),
 * сгорание (−), возврат при возврате товара. Бонусы на картах — обязательство магазина.
 */
@Entity('bonus_entries')
@Index(['tenantId', 'counterpartyId', 'createdAt'])
@Index(['tenantId', 'receiptId', 'kind'], { unique: true, where: 'receipt_id IS NOT NULL' })
export class BonusEntry extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'varchar', length: 12 }) kind: 'accrual' | 'spend' | 'expire' | 'refund' | 'reverse' | 'manual';
  @Column(MONEY_COLUMN) amount: Decimal;
  /** Начисление: сколько ещё не списано и не сгорело */
  @Column({ ...MONEY_COLUMN, default: '0' }) remaining: Decimal;
  @Column({ type: 'uuid', nullable: true }) receiptId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) comment: string | null;
}

/** Клиент магазина в Telegram-боте (ТЗ 22.2): один чат может быть подключён к нескольким магазинам. */
@Entity('customer_telegram')
@Index(['tenantId', 'chatId'], { unique: true })
export class CustomerTelegram extends TenantEntity {
  @Column({ type: 'uuid' }) counterpartyId: string;
  @Column({ type: 'varchar', length: 30 }) chatId: string;
  /** Оптовый клиент получает прайс-лист по расписанию */
  @Column({ default: false }) priceListSubscribed: boolean;
}

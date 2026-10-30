import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Типы денежных счетов (ТЗ 19.1). */
export const MONEY_ACCOUNT_TYPES = ['cash', 'safe', 'bank', 'wallet', 'acquiring', 'accountable'] as const;
export type MoneyAccountType = (typeof MONEY_ACCOUNT_TYPES)[number];

export interface MoneyAccountDetails {
  /** Кошелёк: сервис (MBank, O!Деньги, Optima) и номер */
  provider?: string;
  phone?: string;
  /** Эквайринг: комиссия банка, % */
  commissionPercent?: string;
  bankName?: string;
  accountNumber?: string;
}

@Entity('money_accounts')
@Index(['tenantId', 'type'])
export class MoneyAccount extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 20 })
  type: MoneyAccountType;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** KGS, USD, CNY … */
  @Column({ type: 'varchar', length: 3, default: 'KGS' })
  currency: string;

  @Column({ type: 'uuid', nullable: true })
  storeId: string | null;

  /** Для наличных кассы */
  @Column({ type: 'uuid', nullable: true })
  registerId: string | null;

  /** Чей кошелёк / подотчёт */
  @Column({ type: 'uuid', nullable: true })
  holderMembershipId: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  details: MoneyAccountDetails;

  @Column({ default: true })
  isActive: boolean;
}

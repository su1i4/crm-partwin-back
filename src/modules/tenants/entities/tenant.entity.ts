import { Column, Entity } from 'typeorm';
import { PlatformEntity } from '../../../database/tenant/base.entity';

export type TenantStatus = 'trial' | 'active' | 'suspended';
export type ShopType = 'container' | 'city' | 'wholesale';

export interface TenantLimits {
  stores?: number;
  registers?: number;
  staff?: number;
}

/**
 * Аккаунт (тенант) — один бизнес (ТЗ 3.1). Платформенная таблица: id и есть tenant_id.
 * Магазин видит только свою строку — доступ через TenantsService по id из токена.
 */
@Entity('tenants')
export class Tenant extends PlatformEntity {
  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** ИП | ОсОО | другое */
  @Column({ type: 'varchar', length: 30, nullable: true })
  legalForm: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  inn: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  /** Реквизиты для печатных форм: банк, счёт, БИК … */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  requisites: Record<string, string>;

  @Column({ type: 'uuid', nullable: true })
  logoFileId: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  shopType: ShopType | null;

  /** Язык по умолчанию: ru | ky */
  @Column({ type: 'varchar', length: 5, default: 'ru' })
  language: string;

  @Column({ type: 'varchar', length: 20, default: 'trial' })
  status: TenantStatus;

  @Column({ type: 'timestamptz', nullable: true })
  subscriptionUntil: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  plan: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  limits: TenantLimits;

  @Column({ type: 'uuid' })
  ownerUserId: string;

  @Column({ type: 'timestamptz', nullable: true })
  onboardingCompletedAt: Date | null;
}

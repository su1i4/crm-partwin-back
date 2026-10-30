import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

export type MembershipStatus = 'active' | 'disabled';

/** Участие пользователя в магазине (ТЗ 3.2): роли, доступные точки, статус. */
@Entity('memberships')
@Index('uq_memberships_tenant_user', ['tenantId', 'userId'], { unique: true })
@Index(['userId'])
@Index('uq_memberships_pin', ['tenantId', 'pinLookup'], { unique: true, where: 'pin_lookup IS NOT NULL' })
export class Membership extends TenantEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: MembershipStatus;

  @Column({ default: false })
  isOwner: boolean;

  /** Доступ ко всем точкам магазина (иначе — по membership_store_access) */
  @Column({ default: false })
  allStores: boolean;

  /** Должность / подпись внутри магазина */
  @Column({ type: 'varchar', length: 100, nullable: true })
  position: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  disabledAt: Date | null;

  /** Растёт при каждом изменении прав — для сброса кэша доступа */
  @Column({ type: 'int', default: 1 })
  accessVersion: number;

  /** PIN старшего для подтверждений на кассе: HMAC(магазин, PIN) — уникален в магазине (ТЗ 13.3, 13.8) */
  @Column({ type: 'varchar', length: 64, nullable: true })
  pinLookup: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  pinSetAt: Date | null;

  /** PIN без сети (ТЗ 3.5): PBKDF2(PIN, соль магазина + участник). Касса получает его, обёрнутым секретом устройства */
  @Column({ type: 'varchar', length: 100, nullable: true })
  pinOfflineHash: string | null;
}

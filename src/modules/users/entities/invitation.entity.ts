import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

/** Приглашение сотрудника (ТЗ 3.2): ссылка или код. Храним только хэш кода. */
@Entity('invitations')
export class Invitation extends TenantEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  codeHash: string;

  /** Если задан — принять может только этот логин (нормализованный телефон или email) */
  @Column({ type: 'varchar', length: 200, nullable: true })
  login: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name: string | null;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  roleIds: string[];

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  storeIds: string[];

  @Column({ default: false })
  allStores: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  position: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acceptedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}

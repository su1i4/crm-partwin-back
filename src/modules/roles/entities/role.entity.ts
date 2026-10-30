import { Column, Entity, Index } from 'typeorm';
import { TenantEntity, TenantVersionedEntity } from '../../../database/tenant/base.entity';

export interface RoleSettings {
  /** Лимит ручной скидки в % (ТЗ 3.4) */
  maxDiscountPercent?: number;
}

@Entity('roles')
@Index('uq_roles_tenant_name', ['tenantId', 'name'], { unique: true, where: 'deleted_at IS NULL' })
@Index('uq_roles_tenant_code', ['tenantId', 'code'], { unique: true, where: 'deleted_at IS NULL AND code IS NOT NULL' })
export class Role extends TenantVersionedEntity {
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Код системной роли (owner, admin, seller …); у своих ролей — null */
  @Column({ type: 'varchar', length: 50, nullable: true })
  code: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ default: false })
  isSystem: boolean;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  settings: RoleSettings;
}

@Entity('role_permissions')
@Index('uq_role_permissions', ['roleId', 'permission'], { unique: true })
export class RolePermission extends TenantEntity {
  @Column({ type: 'uuid' })
  roleId: string;

  @Column({ type: 'varchar', length: 100 })
  permission: string;
}

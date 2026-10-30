import { Column, Entity, Index } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';

@Entity('membership_roles')
@Index('uq_membership_roles', ['membershipId', 'roleId'], { unique: true })
export class MembershipRole extends TenantEntity {
  @Column({ type: 'uuid' })
  membershipId: string;

  @Index()
  @Column({ type: 'uuid' })
  roleId: string;
}

/** Доступ к точкам (ТЗ 3.4). */
@Entity('membership_store_access')
@Index('uq_membership_store_access', ['membershipId', 'storeId'], { unique: true })
export class MembershipStoreAccess extends TenantEntity {
  @Column({ type: 'uuid' })
  membershipId: string;

  @Index()
  @Column({ type: 'uuid' })
  storeId: string;
}

/** Необязательное сужение до конкретных складов. Пусто — все склады разрешённых точек. */
@Entity('membership_warehouse_access')
@Index('uq_membership_warehouse_access', ['membershipId', 'warehouseId'], { unique: true })
export class MembershipWarehouseAccess extends TenantEntity {
  @Column({ type: 'uuid' })
  membershipId: string;

  @Index()
  @Column({ type: 'uuid' })
  warehouseId: string;
}

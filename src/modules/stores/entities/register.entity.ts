import { Column, Entity, Index } from 'typeorm';
import { TenantVersionedEntity } from '../../../database/tenant/base.entity';

/** Касса — привязана к точке, работает на зарегистрированном устройстве (ТЗ 3.1, 3.5). */
@Entity('registers')
@Index('uq_registers_tenant_code', ['tenantId', 'code'], { unique: true, where: 'deleted_at IS NULL' })
@Index(['tenantId', 'storeId'])
export class Register extends TenantVersionedEntity {
  @Column({ type: 'uuid' })
  storeId: string;

  /** Код кассы для номера чека: К1 → К1А-000457 */
  @Column({ type: 'varchar', length: 10 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Склад, с которого касса списывает товар */
  @Column({ type: 'uuid' })
  warehouseId: string;

  @Column({ default: true })
  isActive: boolean;
}

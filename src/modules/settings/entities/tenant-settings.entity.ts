import { Column, Entity, Index, VersionColumn } from 'typeorm';
import { TenantEntity } from '../../../database/tenant/base.entity';
import type { TenantSettingsData } from '../settings.types';

@Entity('tenant_settings')
@Index('uq_tenant_settings_tenant', ['tenantId'], { unique: true })
export class TenantSettings extends TenantEntity {
  @Column({ type: 'jsonb', default: () => "'{}'" })
  data: Partial<TenantSettingsData>;

  @VersionColumn({ default: 1 })
  version: number;
}

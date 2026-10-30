import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth.decorators';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { Role } from '../roles/entities/role.entity';
import { ALL_PERMISSIONS } from '../roles/permissions';
import { Store } from '../stores/entities/store.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { UsersService } from '../users/users.service';
import { AccessService } from './access.service';

@Injectable()
export class MeService {
  constructor(
    private readonly users: UsersService,
    private readonly access: AccessService,
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
  ) {}

  async get(u: AuthUser) {
    const user = this.users.toPublic(await this.users.getById(u.userId));
    if (!u.tenantId || !u.membershipId) {
      return { user, tenant: null, membership: null, stores: [] };
    }
    const tenant = await this.platform.repo(Tenant).findOneOrFail({ where: { id: u.tenantId } });
    const m = (await this.access.load(u.tenantId, u.membershipId, u.userId))!;
    const { roles, stores } = await this.tenantTx.run(async (tx) => ({
      roles: await tx.repo(Role).findByIds(m.roleIds),
      stores: await tx.repo(Store).find({ order: { name: 'ASC' } }),
    }));
    const visibleStores = m.allStores ? stores : stores.filter((s) => m.storeIds.includes(s.id));
    return {
      user,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        shopType: tenant.shopType,
        language: tenant.language,
        subscriptionUntil: tenant.subscriptionUntil,
        onboardingCompleted: !!tenant.onboardingCompletedAt,
      },
      membership: {
        id: m.membershipId,
        isOwner: m.isOwner,
        allStores: m.allStores,
        storeIds: m.allStores ? null : m.storeIds,
        warehouseIds: m.warehouseIds.length ? m.warehouseIds : null,
        roles: roles.map((r) => ({ id: r.id, name: r.name, code: r.code })),
        permissions: m.isOwner ? [...ALL_PERMISSIONS] : m.permissions,
        maxDiscountPercent: m.maxDiscountPercent,
      },
      stores: visibleStores.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        timezone: s.timezone,
        registerMode: s.registerMode,
        isActive: s.isActive,
      })),
    };
  }
}

import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth.decorators';
import { RequestContext } from '../../common/context/request-context';
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
    private readonly ctx: RequestContext,
  ) {}

  async get(u: AuthUser) {
    // Сеанс поддержки платформы: пользователя магазина нет — отдаём «поддержку» с правами сеанса
    const supportSessionId = this.ctx.get('supportSessionId') as string | undefined;
    if (supportSessionId && u.tenantId) return this.supportMe(u, supportSessionId);
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

  private async supportMe(u: AuthUser, sessionId: string) {
    const [s] = await this.platform.ds.query(
      `SELECT s.can_write AS "canWrite", s.show_money AS "showMoney", s.expires_at AS "expiresAt", a.name FROM support_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.id = $1`,
      [sessionId],
    );
    const tenant = await this.platform.repo(Tenant).findOneOrFail({ where: { id: u.tenantId! } });
    const stores = await this.tenantTx.run((tx) => tx.repo(Store).find({ order: { name: 'ASC' } }));
    return {
      user: { id: u.userId, name: `Поддержка · ${s?.name ?? ''}`.trim(), phone: null, email: null, locale: 'ru', totpEnabled: true, telegramLinked: false, lastLoginAt: null },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        status: tenant.status,
        shopType: tenant.shopType,
        language: tenant.language,
        subscriptionUntil: tenant.subscriptionUntil,
        onboardingCompleted: true,
      },
      membership: { id: sessionId, isOwner: false, allStores: true, storeIds: null, warehouseIds: null, roles: [], permissions: this.ctx.permissions, maxDiscountPercent: null },
      stores: stores.map((x) => ({ id: x.id, name: x.name, code: x.code, timezone: x.timezone, registerMode: x.registerMode, isActive: x.isActive })),
      support: { sessionId, canWrite: !!s?.canWrite, showMoney: !!s?.showMoney, expiresAt: s?.expiresAt ?? null },
    };
  }
}

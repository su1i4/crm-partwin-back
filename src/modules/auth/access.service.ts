import { Injectable } from '@nestjs/common';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { PlatformDb } from '../../database/tenant/platform-db';
import { Tenant } from '../tenants/entities/tenant.entity';
import { UserSession } from '../users/entities/user-session.entity';

export interface MembershipAccess {
  membershipId: string;
  userId: string;
  tenantId: string;
  status: string;
  isOwner: boolean;
  allStores: boolean;
  permissions: string[];
  storeIds: string[];
  warehouseIds: string[];
  maxDiscountPercent: number;
  roleIds: string[];
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const TTL_MS = 15_000;

/**
 * Загружает права участника магазина для каждого запроса (с коротким кэшем в памяти).
 * После изменения ролей/доступа вызывайте invalidate*, чтобы не ждать TTL.
 * Кэш — в памяти процесса: при нескольких процессах PM2 изменения применятся не позже TTL.
 */
@Injectable()
export class AccessService {
  private readonly memberships = new Map<string, CacheEntry<MembershipAccess | null>>();
  private readonly sessions = new Map<string, CacheEntry<UserSession | null>>();
  private readonly tenants = new Map<string, CacheEntry<Tenant | null>>();

  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
  ) {}

  async getSession(sessionId: string): Promise<UserSession | null> {
    return this.cached(this.sessions, sessionId, () =>
      this.platform.repo(UserSession).findOne({ where: { id: sessionId } }),
    );
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    return this.cached(this.tenants, tenantId, () => this.platform.repo(Tenant).findOne({ where: { id: tenantId } }));
  }

  async getMembershipAccess(tenantId: string, membershipId: string, userId: string): Promise<MembershipAccess | null> {
    return this.cached(this.memberships, membershipId, () => this.load(tenantId, membershipId, userId));
  }

  /** Загрузка без кэша — для проверок «не больше своих прав». */
  async load(tenantId: string, membershipId: string, userId: string): Promise<MembershipAccess | null> {
    return this.tenantTx.run(
      async (tx) => {
        const [m] = await tx.query<{
          id: string;
          user_id: string;
          status: string;
          is_owner: boolean;
          all_stores: boolean;
        }>(
          `SELECT id, user_id, status, is_owner, all_stores FROM memberships
           WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
          [membershipId, tenantId, userId],
        );
        if (!m) return null;

        const roles = await tx.query<{ role_id: string; max_discount: string | null }>(
          `SELECT r.id AS role_id, r.settings->>'maxDiscountPercent' AS max_discount
             FROM membership_roles mr
             JOIN roles r ON r.id = mr.role_id AND r.deleted_at IS NULL
            WHERE mr.membership_id = $1 AND mr.tenant_id = $2`,
          [membershipId, tenantId],
        );
        const roleIds = roles.map((r) => r.role_id);
        const perms = roleIds.length
          ? await tx.query<{ permission: string }>(
              `SELECT DISTINCT permission FROM role_permissions WHERE tenant_id = $1 AND role_id = ANY($2::uuid[])`,
              [tenantId, roleIds],
            )
          : [];
        const stores = await tx.query<{ store_id: string }>(
          `SELECT a.store_id FROM membership_store_access a
             JOIN stores s ON s.id = a.store_id AND s.deleted_at IS NULL
            WHERE a.membership_id = $1 AND a.tenant_id = $2`,
          [membershipId, tenantId],
        );
        const whs = await tx.query<{ warehouse_id: string }>(
          `SELECT warehouse_id FROM membership_warehouse_access WHERE membership_id = $1 AND tenant_id = $2`,
          [membershipId, tenantId],
        );

        const maxDiscountPercent = m.is_owner
          ? 100
          : roles.reduce((acc, r) => Math.max(acc, Number(r.max_discount ?? 0) || 0), 0);

        return {
          membershipId: m.id,
          userId: m.user_id,
          tenantId,
          status: m.status,
          isOwner: m.is_owner,
          allStores: m.is_owner || m.all_stores,
          permissions: perms.map((p) => p.permission),
          storeIds: stores.map((s) => s.store_id),
          warehouseIds: whs.map((w) => w.warehouse_id),
          maxDiscountPercent,
          roleIds,
        } satisfies MembershipAccess;
      },
      { tenantId, userId },
    );
  }

  invalidateMembership(membershipId: string) {
    this.memberships.delete(membershipId);
  }
  invalidateTenantMemberships(tenantId: string) {
    for (const [k, v] of this.memberships) if (v.value?.tenantId === tenantId) this.memberships.delete(k);
  }
  invalidateSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }
  invalidateUserSessions(userId: string) {
    for (const [k, v] of this.sessions) if (v.value?.userId === userId) this.sessions.delete(k);
  }
  invalidateTenant(tenantId: string) {
    this.tenants.delete(tenantId);
  }

  private async cached<T>(map: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await load();
    map.set(key, { at: Date.now(), value });
    if (map.size > 5000) {
      const first = map.keys().next().value;
      if (first) map.delete(first);
    }
    return value;
  }
}

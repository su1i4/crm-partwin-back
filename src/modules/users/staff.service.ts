import { Injectable } from '@nestjs/common';
import { IsNull, MoreThan } from 'typeorm';
import { TelegramService } from '../telegram/telegram.service';
import { AppConfig } from '../../config/app.config';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { randomCode, sha256 } from '../../common/utils/crypto';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { ScopeService } from '../auth/scope.service';
import { SessionsService } from '../auth/sessions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.service';
import { Role, RolePermission } from '../roles/entities/role.entity';
import { ALL_PERMISSIONS } from '../roles/permissions';
import { RolesService } from '../roles/roles.service';
import { Store } from '../stores/entities/store.entity';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { CreateInvitationDto, StaffQueryDto, TransferOwnershipDto, UpdateMemberDto } from './dto/staff.dto';
import { Invitation } from './entities/invitation.entity';
import { MembershipRole, MembershipStoreAccess, MembershipWarehouseAccess } from './entities/membership-access.entity';
import { Membership } from './entities/membership.entity';
import { UsersService } from './users.service';

/** Сотрудники магазина: участие, роли, доступ к точкам, приглашения (ТЗ 3.2–3.4, 3.6). */
@Injectable()
export class StaffService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly scope: ScopeService,
    private readonly roles: RolesService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly platform: PlatformDb,
    private readonly config: AppConfig,
    private readonly telegram: TelegramService,
  ) {}

  // ── Список и карточка ───────────────────────────────────

  async list(q: StaffQueryDto) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const where: string[] = ['m.tenant_id = $1'];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      if (q.status) where.push(`m.status = ${p(q.status)}`);
      if (q.roleId) where.push(`EXISTS (SELECT 1 FROM membership_roles r WHERE r.membership_id = m.id AND r.role_id = ${p(q.roleId)})`);
      if (q.storeId) {
        this.scope.assertStore(q.storeId);
        where.push(
          `(m.all_stores OR m.is_owner OR EXISTS (SELECT 1 FROM membership_store_access a WHERE a.membership_id = m.id AND a.store_id = ${p(q.storeId)}))`,
        );
      }
      const mine = this.scope.storeIds();
      if (mine !== null) {
        // Управляющий видит сотрудников своих точек
        where.push(
          `NOT m.all_stores AND NOT m.is_owner AND EXISTS (SELECT 1 FROM membership_store_access a WHERE a.membership_id = m.id AND a.store_id = ANY(${p(mine)}::uuid[]))`,
        );
      }
      if (q.q) where.push(`(u.name ILIKE '%' || ${p(q.q)} || '%' OR u.phone LIKE '%' || $${params.length} || '%' OR u.email ILIKE '%' || $${params.length} || '%')`);
      const whereSql = where.join(' AND ');
      const [{ total }] = await tx.query(
        `SELECT count(*)::int AS total FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${whereSql}`,
        params,
      );
      const rows = await tx.query(
        `SELECT m.id, m.user_id AS "userId", m.status, m.is_owner AS "isOwner", m.all_stores AS "allStores",
                m.position, m.created_at AS "joinedAt", m.disabled_at AS "disabledAt",
                u.name, u.phone, u.email, u.last_login_at AS "lastLoginAt", u.totp_enabled AS "totpEnabled"
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE ${whereSql}
          ORDER BY m.is_owner DESC, m.status, u.name
          LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      const ids = rows.map((r: any) => r.id);
      const details = await this.accessDetails(tx, ids);
      return { items: rows.map((r: any) => ({ ...r, ...details.get(r.id) })), total };
    });
  }

  async get(id: string) {
    return this.tenantTx.run(async (tx) => {
      const m = await this.loadVisible(tx, id);
      const user = await this.users.getById(m.userId);
      const details = await this.accessDetails(tx, [m.id]);
      return {
        id: m.id,
        userId: m.userId,
        status: m.status,
        isOwner: m.isOwner,
        allStores: m.allStores,
        position: m.position,
        joinedAt: m.createdAt,
        disabledAt: m.disabledAt,
        name: user.name,
        phone: user.phone,
        email: user.email,
        lastLoginAt: user.lastLoginAt,
        totpEnabled: user.totpEnabled,
        ...details.get(m.id),
      };
    });
  }

  private async accessDetails(tx: TenantTx, ids: string[]) {
    const map = new Map<string, { roles: { id: string; name: string; code: string | null }[]; storeIds: string[]; warehouseIds: string[] }>();
    if (!ids.length) return map;
    for (const id of ids) map.set(id, { roles: [], storeIds: [], warehouseIds: [] });
    const roles = await tx.query(
      `SELECT mr.membership_id, r.id, r.name, r.code FROM membership_roles mr
         JOIN roles r ON r.id = mr.role_id AND r.deleted_at IS NULL
        WHERE mr.tenant_id = $1 AND mr.membership_id = ANY($2::uuid[]) ORDER BY r.name`,
      [tx.tenantId, ids],
    );
    for (const r of roles) map.get(r.membership_id)!.roles.push({ id: r.id, name: r.name, code: r.code });
    const stores = await tx.query(
      `SELECT membership_id, store_id FROM membership_store_access WHERE tenant_id = $1 AND membership_id = ANY($2::uuid[])`,
      [tx.tenantId, ids],
    );
    for (const s of stores) map.get(s.membership_id)!.storeIds.push(s.store_id);
    const whs = await tx.query(
      `SELECT membership_id, warehouse_id FROM membership_warehouse_access WHERE tenant_id = $1 AND membership_id = ANY($2::uuid[])`,
      [tx.tenantId, ids],
    );
    for (const w of whs) map.get(w.membership_id)!.warehouseIds.push(w.warehouse_id);
    return map;
  }

  /** Участие, которое текущий пользователь вправе видеть (иначе 404). */
  private async loadVisible(tx: TenantTx, id: string): Promise<Membership> {
    const m = await tx.repo(Membership, 'Сотрудник').getById(id);
    const mine = this.scope.storeIds();
    if (mine !== null && m.id !== this.ctx.membershipId) {
      if (m.isOwner || m.allStores) throw Errors.notFound('Сотрудник');
      const theirs = (await tx.repo(MembershipStoreAccess).find({ where: { membershipId: m.id } })).map((a) => a.storeId);
      if (!theirs.some((s) => mine.includes(s))) throw Errors.notFound('Сотрудник');
    }
    return m;
  }

  // ── Права: «нельзя выдать больше, чем есть у себя» ──────

  private async permissionsOfRoles(tx: TenantTx, roleIds: string[]): Promise<{ roles: Role[]; permissions: string[] }> {
    if (!roleIds.length) return { roles: [], permissions: [] };
    const roles = await tx.repo(Role, 'Роль').getByIds(roleIds);
    if (roles.some((r) => r.code === 'owner')) {
      return { roles, permissions: [...ALL_PERMISSIONS] };
    }
    const perms = await tx.repo(RolePermission).find({ where: roleIds.map((roleId) => ({ roleId })) });
    return { roles, permissions: [...new Set(perms.map((p) => p.permission))] };
  }

  /** Может ли текущий пользователь менять доступ этого сотрудника (его текущие права ⊆ моих, точки ⊆ моих). */
  private async assertCanManage(tx: TenantTx, target: Membership) {
    if (target.isOwner && !this.ctx.isOwner) throw Errors.forbidden('Владельца может изменить только он сам');
    if (this.ctx.isOwner) return;
    const currentRoles = (await tx.repo(MembershipRole).find({ where: { membershipId: target.id } })).map((r) => r.roleId);
    const { permissions } = await this.permissionsOfRoles(tx, currentRoles);
    this.roles.assertCanGrant(permissions);
    const mine = this.scope.storeIds();
    if (mine !== null) {
      if (target.allStores) throw Errors.forbidden('У сотрудника доступ ко всем точкам — изменить может только сотрудник с таким же доступом');
      const theirs = (await tx.repo(MembershipStoreAccess).find({ where: { membershipId: target.id } })).map((a) => a.storeId);
      const outside = theirs.filter((s) => !mine.includes(s));
      if (outside.length) throw Errors.forbidden('У сотрудника есть доступ к точкам, которых нет у вас');
    }
  }

  private async validateAccessPatch(
    tx: TenantTx,
    dto: { roleIds?: string[]; allStores?: boolean; storeIds?: string[]; warehouseIds?: string[] },
  ) {
    if (dto.roleIds) {
      const { roles, permissions } = await this.permissionsOfRoles(tx, dto.roleIds);
      if (roles.some((r) => r.code === 'owner')) throw Errors.forbidden('Роль «Владелец» передаётся только передачей владения');
      this.roles.assertCanGrant(permissions);
    }
    if (dto.allStores && !this.scope.hasAllStores()) throw Errors.forbidden('Нельзя выдать доступ ко всем точкам');
    if (dto.storeIds) {
      const stores = await tx.repo(Store, 'Точка').getByIds(dto.storeIds);
      for (const s of stores) this.scope.assertStore(s.id);
    }
    if (dto.warehouseIds?.length) {
      const whs = await tx.repo(Warehouse, 'Склад').getByIds(dto.warehouseIds);
      for (const w of whs) await this.scope.assertWarehouse(tx, w.id);
      if (!dto.allStores && dto.storeIds) {
        const bad = whs.filter((w) => !w.storeId || !dto.storeIds!.includes(w.storeId));
        if (bad.length) throw Errors.bad('WAREHOUSE_NOT_IN_STORES', 'Склады должны относиться к выбранным точкам');
      }
    }
  }

  // ── Изменение сотрудника ────────────────────────────────

  async update(id: string, dto: UpdateMemberDto) {
    const result = await this.tenantTx.run(async (tx) => {
      const m = await this.loadVisible(tx, id);
      await this.assertCanManage(tx, m);
      if (m.isOwner && (dto.roleIds || dto.allStores === false || dto.storeIds)) {
        throw Errors.forbidden('У владельца всегда полный доступ');
      }
      await this.validateAccessPatch(tx, dto);
      const before = await this.get(id);

      if (dto.roleIds) {
        await tx.repo(MembershipRole).hardDelete({ membershipId: id });
        await tx.repo(MembershipRole).insertMany(dto.roleIds.map((roleId) => ({ membershipId: id, roleId })));
      }
      if (dto.allStores !== undefined) m.allStores = dto.allStores;
      if (dto.storeIds) {
        await tx.repo(MembershipStoreAccess).hardDelete({ membershipId: id });
        await tx.repo(MembershipStoreAccess).insertMany(dto.storeIds.map((storeId) => ({ membershipId: id, storeId })));
      }
      if (dto.warehouseIds) {
        await tx.repo(MembershipWarehouseAccess).hardDelete({ membershipId: id });
        await tx
          .repo(MembershipWarehouseAccess)
          .insertMany(dto.warehouseIds.map((warehouseId) => ({ membershipId: id, warehouseId })));
      }
      if (dto.position !== undefined) m.position = dto.position;
      m.accessVersion += 1;
      await tx.repo(Membership).save(m);

      const after = await this.get(id);
      await this.audit.log(tx, {
        action: 'member.update',
        entityType: 'membership',
        entityId: id,
        summary: `Изменён доступ: ${after.name}`,
        before,
        after,
        important: true,
      });
      await this.notifications.notify(tx, {
        type: 'staff.changed',
        title: `Изменён доступ сотрудника ${after.name}`,
        entityType: 'membership',
        entityId: id,
        ownersOnly: true,
        excludeUserId: tx.userId,
        link: `/settings/staff/${id}`,
      });
      return after;
    });
    this.access.invalidateMembership(id);
    return result;
  }

  /** Уволили сотрудника: участие отключено, все сессии в магазине завершены, история сохраняется (ТЗ 3.6). */
  async disable(id: string) {
    const m = await this.tenantTx.run(async (tx) => {
      const m = await this.loadVisible(tx, id);
      if (m.id === this.ctx.membershipId) throw Errors.bad('SELF_DISABLE', 'Нельзя отключить себя');
      if (m.isOwner) throw Errors.forbidden('Владельца отключить нельзя. Сначала передайте владение');
      await this.assertCanManage(tx, m);
      if (m.status === 'disabled') return m;
      m.status = 'disabled';
      m.disabledAt = new Date();
      m.accessVersion += 1;
      await tx.repo(Membership).save(m);
      const user = await this.users.getById(m.userId);
      await this.audit.log(tx, {
        action: 'member.disable',
        entityType: 'membership',
        entityId: id,
        summary: `Отключён сотрудник ${user.name}`,
        important: true,
      });
      return m;
    });
    this.access.invalidateMembership(id);
    await this.sessions.revokeForMembership(m.userId, m.tenantId, 'membership_disabled');
    this.realtime.disconnectUser(m.tenantId, m.userId);
    return { id, status: 'disabled' };
  }

  async enable(id: string) {
    await this.tenantTx.run(async (tx) => {
      const m = await this.loadVisible(tx, id);
      await this.assertCanManage(tx, m);
      if (m.status === 'active') return;
      await this.assertStaffLimit(tx);
      m.status = 'active';
      m.disabledAt = null;
      m.accessVersion += 1;
      await tx.repo(Membership).save(m);
      await this.audit.log(tx, { action: 'member.enable', entityType: 'membership', entityId: id, important: true });
    });
    this.access.invalidateMembership(id);
    return { id, status: 'active' };
  }

  /**
   * Сброс пароля владельцем (ТЗ 3.5). Учётная запись общая для платформы, поэтому сбросить можно,
   * только если человек не работает в других магазинах — иначе только через Telegram-бот (POST /auth/telegram-reset/request).
   */
  async resetPassword(id: string) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Сбросить пароль может только владелец');
    const m = await this.tenantTx.run((tx) => this.loadVisible(tx, id));
    if (m.isOwner) throw Errors.bad('OWNER_RESET', 'Свой пароль меняйте в профиле');
    const others = (await this.users.listTenants(m.userId, true)).filter((t) => t.tenantId !== m.tenantId);
    if (others.length) {
      throw Errors.conflict(
        'USER_IN_OTHER_SHOPS',
        'Сотрудник работает и в других магазинах — пароль он сбрасывает сам через Telegram-бот',
      );
    }
    const temp = randomCode(4) + '-' + randomCode(4);
    await this.users.setPassword(m.userId, temp);
    await this.sessions.revokeAllForUser(m.userId, 'password_reset');
    await this.tenantTx.run((tx) =>
      this.audit.log(tx, { action: 'member.reset_password', entityType: 'membership', entityId: id, important: true }),
    );
    return { temporaryPassword: temp };
  }

  /**
   * Передача владения (ТЗ 3.4): пароль, а при привязанном Telegram — ещё и код из бота.
   */
  async transferOwnership(dto: TransferOwnershipDto) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Передать владение может только владелец');
    await this.users.verifyPasswordOnly(this.ctx.userId!, dto.password);
    // Telegram привязан — ещё и код из бота (ТЗ 22.2): одного пароля мало для передачи магазина
    if (this.telegram.enabled && (await this.telegram.isLinked(this.ctx.userId!))) {
      if (!dto.telegramCode) throw Errors.bad('TELEGRAM_CODE_REQUIRED', 'Подтвердите кодом из Telegram (POST /staff/transfer-ownership/code)');
      await this.telegram.verifyCode(this.ctx.userId!, 'ownership', dto.telegramCode);
    }
    const tenantId = this.ctx.requireTenantId();
    const res = await this.tenantTx.run(async (tx) => {
      const target = await tx.repo(Membership, 'Сотрудник').getById(dto.membershipId, { lock: { mode: 'pessimistic_write' } } as any);
      if (target.status !== 'active') throw Errors.bad('MEMBER_DISABLED', 'Сотрудник отключён');
      if (target.isOwner) throw Errors.bad('ALREADY_OWNER', 'Он уже владелец');
      const me = await tx.repo(Membership).getById(this.ctx.membershipId!, { lock: { mode: 'pessimistic_write' } } as any);
      const ownerRole = await tx.repo(Role).findOne({ where: { code: 'owner' } });
      const adminRole = await tx.repo(Role).findOne({ where: { code: 'admin' } });
      if (!ownerRole || !adminRole) throw new Error('Нет системных ролей owner/admin');

      target.isOwner = true;
      target.allStores = true;
      target.accessVersion += 1;
      await tx.repo(Membership).save(target);
      await tx.repo(MembershipRole).hardDelete({ membershipId: target.id });
      await tx.repo(MembershipRole).insert({ membershipId: target.id, roleId: ownerRole.id });

      me.isOwner = false;
      me.accessVersion += 1;
      await tx.repo(Membership).save(me);
      await tx.repo(MembershipRole).hardDelete({ membershipId: me.id });
      await tx.repo(MembershipRole).insert({ membershipId: me.id, roleId: adminRole.id });

      await tx.manager.update(Tenant, { id: tenantId }, { ownerUserId: target.userId });
      await this.audit.log(tx, {
        action: 'tenant.transfer_ownership',
        entityType: 'membership',
        entityId: target.id,
        summary: 'Передача владения магазином',
        before: { ownerMembershipId: me.id },
        after: { ownerMembershipId: target.id },
        important: true,
      });
      return { from: me.id, to: target.id };
    });
    this.access.invalidateMembership(res.from);
    this.access.invalidateMembership(res.to);
    this.access.invalidateTenant(tenantId);
    return res;
  }

  // ── Приглашения ─────────────────────────────────────────

  async listInvitations() {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.repo(Invitation).find({
        where: { acceptedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
        order: { createdAt: 'DESC' },
      });
      const mine = this.scope.storeIds();
      return rows
        .filter((r) => mine === null || (!r.allStores && r.storeIds.every((s) => mine.includes(s))))
        .map(({ codeHash: _c, ...r }) => r);
    });
  }

  async createInvitation(dto: CreateInvitationDto) {
    let login: string | null = null;
    if (dto.login) login = this.users.loginString(this.users.parseLoginOrFail(dto.login));
    if (!dto.allStores && !dto.storeIds?.length) throw Errors.bad('NO_STORES', 'Выберите точки или «все точки»');
    if (!dto.roleIds.length) throw Errors.bad('NO_ROLES', 'Выберите хотя бы одну роль');
    return this.tenantTx.run(async (tx) => {
      await this.validateAccessPatch(tx, { roleIds: dto.roleIds, allStores: dto.allStores, storeIds: dto.storeIds });
      await this.assertStaffLimit(tx);
      const code = randomCode(8);
      const inv = await tx.repo(Invitation).insert({
        codeHash: sha256(code),
        login,
        name: dto.name ?? null,
        roleIds: dto.roleIds,
        storeIds: dto.allStores ? [] : (dto.storeIds ?? []),
        allStores: !!dto.allStores,
        position: dto.position ?? null,
        expiresAt: new Date(Date.now() + (dto.expiresInDays ?? 7) * 86_400_000),
      });
      await this.audit.log(tx, {
        action: 'invitation.create',
        entityType: 'invitation',
        entityId: inv.id,
        summary: `Приглашение${dto.name ? ' для ' + dto.name : ''}`,
        after: inv,
        important: true,
      });
      const { codeHash: _c, ...view } = inv;
      return { ...view, code, link: `${this.config.publicUrl}/invite/${code}` };
    });
  }

  async revokeInvitation(id: string) {
    await this.tenantTx.run(async (tx) => {
      const inv = await tx.repo(Invitation, 'Приглашение').getById(id);
      const mine = this.scope.storeIds();
      if (mine !== null && (inv.allStores || !inv.storeIds.every((s) => mine.includes(s)))) {
        throw Errors.notFound('Приглашение');
      }
      if (inv.acceptedAt) throw Errors.conflict('INVITE_USED', 'Приглашение уже принято');
      inv.revokedAt = new Date();
      await tx.repo(Invitation).save(inv);
      await this.audit.log(tx, { action: 'invitation.revoke', entityType: 'invitation', entityId: id });
    });
  }

  private async assertStaffLimit(tx: TenantTx) {
    const tenant = await this.platform.repo(Tenant).findOne({ where: { id: tx.tenantId } });
    const limit = tenant?.limits?.staff;
    if (limit === undefined || limit === null) return;
    const active = await tx.repo(Membership).count({ where: { status: 'active' } });
    const pending = await tx.repo(Invitation).count({
      where: { acceptedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    });
    if (active + pending >= limit) throw Errors.conflict('PLAN_LIMIT', `Достигнут лимит тарифа: ${limit} сотрудников`);
  }
}

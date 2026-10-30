import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MembershipRole } from '../users/entities/membership-access.entity';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { Role, RolePermission } from './entities/role.entity';
import { ALL_PERMISSIONS, OWNER_ONLY, PERMISSIONS, isPermission } from './permissions';

@Injectable()
export class RolesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  catalog() {
    const groups = new Map<string, { code: string; label: string }[]>();
    for (const [code, label] of Object.entries(PERMISSIONS)) {
      const group = code.split('.')[0];
      const list = groups.get(group) ?? [];
      list.push({ code, label });
      groups.set(group, list);
    }
    return [...groups.entries()].map(([group, permissions]) => ({ group, permissions }));
  }

  async list() {
    return this.tenantTx.run(async (tx) => {
      const roles = await tx.repo(Role).find({ order: { isSystem: 'DESC', name: 'ASC' } });
      const perms = await tx.repo(RolePermission).find();
      const counts = await tx.query<{ role_id: string; n: number }>(
        `SELECT mr.role_id, count(*)::int AS n FROM membership_roles mr
           JOIN memberships m ON m.id = mr.membership_id AND m.status = 'active'
          WHERE mr.tenant_id = $1 GROUP BY mr.role_id`,
        [tx.tenantId],
      );
      return roles.map((r) => this.view(r, perms, counts.find((c) => c.role_id === r.id)?.n ?? 0));
    });
  }

  async get(id: string) {
    return this.tenantTx.run(async (tx) => {
      const role = await tx.repo(Role, 'Роль').getById(id);
      const perms = await tx.repo(RolePermission).find({ where: { roleId: id } });
      return this.view(role, perms, 0);
    });
  }

  private view(r: Role, perms: RolePermission[], membersCount: number) {
    return {
      id: r.id,
      name: r.name,
      code: r.code,
      description: r.description,
      isSystem: r.isSystem,
      maxDiscountPercent: r.settings?.maxDiscountPercent ?? 0,
      permissions: r.code === 'owner' ? [...ALL_PERMISSIONS] : perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
      membersCount,
      version: r.version,
    };
  }

  /** «Нельзя выдать больше, чем есть у себя» (ТЗ 3.4). */
  assertCanGrant(permissions: string[], maxDiscountPercent?: number) {
    const unknown = permissions.filter((p) => !isPermission(p));
    if (unknown.length) throw Errors.bad('UNKNOWN_PERMISSION', 'Неизвестные разрешения', unknown);
    const ownerOnly = permissions.filter((p) => (OWNER_ONLY as string[]).includes(p));
    if (ownerOnly.length) throw Errors.forbidden('Эти разрешения есть только у владельца: ' + ownerOnly.join(', '));
    if (this.ctx.isOwner) return;
    const missing = permissions.filter((p) => !this.ctx.can(p));
    if (missing.length) {
      throw Errors.forbidden(`Нельзя выдать разрешения, которых нет у вас: ${missing.join(', ')}`);
    }
    if (maxDiscountPercent !== undefined) {
      const mine = this.myMaxDiscount();
      if (maxDiscountPercent > mine) throw Errors.forbidden(`Лимит скидки не может быть больше вашего (${mine}%)`);
    }
  }

  private myMaxDiscount(): number {
    // Владелец и роли с sales.discount_unlimited — без ограничения
    if (this.ctx.isOwner || this.ctx.can('sales.discount_unlimited')) return 100;
    return this.ctx.get('maxDiscountPercent') ?? 0;
  }

  async create(dto: CreateRoleDto) {
    this.assertCanGrant(dto.permissions, dto.maxDiscountPercent);
    return this.tenantTx.run(async (tx) => {
      const role = await tx.repo(Role).insert({
        name: dto.name.trim(),
        description: dto.description ?? null,
        isSystem: false,
        settings: { maxDiscountPercent: dto.maxDiscountPercent ?? 0 },
      });
      await tx.repo(RolePermission).insertMany(dto.permissions.map((permission) => ({ roleId: role.id, permission })));
      await this.audit.log(tx, {
        action: 'role.create',
        entityType: 'role',
        entityId: role.id,
        summary: `Создана роль «${role.name}»`,
        after: { ...role, permissions: dto.permissions },
        important: true,
      });
      return this.view(role, await tx.repo(RolePermission).find({ where: { roleId: role.id } }), 0);
    });
  }

  async update(id: string, dto: UpdateRoleDto) {
    return this.tenantTx.run(async (tx) => {
      const role = await tx.repo(Role, 'Роль').getById(id, { lock: { mode: 'pessimistic_write' } } as any);
      if (role.version !== dto.version) throw Errors.versionConflict();
      if (role.code === 'owner') throw Errors.forbidden('Роль «Владелец» изменить нельзя');
      const oldPerms = (await tx.repo(RolePermission).find({ where: { roleId: id } })).map((p) => p.permission);
      const newPerms = dto.permissions ?? oldPerms;
      // Менять можно только роль, все разрешения которой (старые и новые) есть у вас
      this.assertCanGrant([...new Set([...oldPerms, ...newPerms])], dto.maxDiscountPercent);

      const before = { ...role, permissions: oldPerms };
      if (dto.name !== undefined) role.name = dto.name.trim();
      if (dto.description !== undefined) role.description = dto.description;
      if (dto.maxDiscountPercent !== undefined) role.settings = { ...role.settings, maxDiscountPercent: dto.maxDiscountPercent };
      const saved = await tx.repo(Role).save(role);

      if (dto.permissions) {
        await tx.repo(RolePermission).hardDelete({ roleId: id });
        await tx.repo(RolePermission).insertMany(newPerms.map((permission) => ({ roleId: id, permission })));
      }
      await this.audit.log(tx, {
        action: 'role.update',
        entityType: 'role',
        entityId: id,
        summary: `Изменена роль «${saved.name}»`,
        before,
        after: { ...saved, permissions: newPerms },
        important: true,
      });
      await this.notifications.notify(tx, {
        type: 'staff.changed',
        title: `Изменена роль «${saved.name}»`,
        entityType: 'role',
        entityId: id,
        ownersOnly: true,
        excludeUserId: tx.userId,
        link: `/settings/roles/${id}`,
      });
      tx.onCommit(() => this.access.invalidateTenantMemberships(tx.tenantId));
      return this.view(saved, await tx.repo(RolePermission).find({ where: { roleId: id } }), 0);
    });
  }

  async remove(id: string, version: number) {
    await this.tenantTx.run(async (tx: TenantTx) => {
      const role = await tx.repo(Role, 'Роль').getById(id);
      if (role.version !== version) throw Errors.versionConflict();
      if (role.isSystem) throw Errors.forbidden('Системную роль удалить нельзя');
      const used = await tx.repo(MembershipRole).count({ where: { roleId: id } });
      if (used) throw Errors.conflict('ROLE_IN_USE', `Роль назначена сотрудникам (${used}). Сначала снимите её`);
      const perms = (await tx.repo(RolePermission).find({ where: { roleId: id } })).map((p) => p.permission);
      this.assertCanGrant(perms);
      await tx.repo(RolePermission).hardDelete({ roleId: id });
      await tx.repo(Role).softDelete(id);
      await this.audit.log(tx, {
        action: 'role.delete',
        entityType: 'role',
        entityId: id,
        summary: `Удалена роль «${role.name}»`,
        before: { ...role, permissions: perms },
        important: true,
      });
    });
  }
}

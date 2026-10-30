import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app.config';
import { Errors } from '../../common/errors/app.exception';
import { sha256 } from '../../common/utils/crypto';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { Role } from '../roles/entities/role.entity';
import { Store } from '../stores/entities/store.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { TenantBootstrapService } from '../tenants/tenant-bootstrap.service';
import { Invitation } from '../users/entities/invitation.entity';
import { Membership } from '../users/entities/membership.entity';
import { MembershipRole, MembershipStoreAccess } from '../users/entities/membership-access.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AccessService } from './access.service';
import { AcceptInviteDto, LoginDto, RegisterDto } from './dto/auth.dto';
import { ClientMeta, IssuedTokens, SessionsService } from './sessions.service';

const TRIAL_DAYS = 14;

export interface AuthResult {
  tokens: IssuedTokens;
  user: ReturnType<UsersService['toPublic']>;
  tenants: Awaited<ReturnType<UsersService['listTenants']>>;
  currentTenantId: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly platform: PlatformDb,
    private readonly tenantTx: TenantTransaction,
    private readonly bootstrap: TenantBootstrapService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /** Регистрация владельца с магазином (мастер, шаг 1–2). */
  async register(dto: RegisterDto, meta: ClientMeta): Promise<AuthResult> {
    const login = this.users.parseLoginOrFail(dto.login);
    const { user, tenantId, membershipId } = await this.platform.transaction(async (manager) => {
      const user = await this.users.create(
        { name: dto.name, login, password: dto.password, locale: dto.locale },
        manager,
      );
      const tenantRepo = this.platform.repoIn(manager, Tenant);
      const tenant = await tenantRepo.save(
        tenantRepo.create({
          name: dto.shopName.trim(),
          ownerUserId: user.id,
          status: 'trial',
          language: dto.locale ?? 'ru',
          subscriptionUntil: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
        }),
      );
      const { membership } = await this.tenantTx.runInManager(manager, tenant.id, user.id, async (tx) => {
        const res = await this.bootstrap.createDefaults(tx, user.id);
        await this.audit.log(tx, {
          action: 'tenant.register',
          entityType: 'tenant',
          entityId: tenant.id,
          summary: `Регистрация магазина «${tenant.name}»`,
          important: true,
        });
        return res;
      });
      return { user, tenantId: tenant.id, membershipId: membership.id };
    });
    await this.users.touchLogin(user.id);
    const tokens = await this.sessions.create(user.id, { tenantId, membershipId }, meta);
    return this.result(user, tokens, tenantId);
  }

  /** Вход: если магазин один — сразу выбран; если несколько — токен без магазина + список. */
  async login(dto: LoginDto, meta: ClientMeta): Promise<AuthResult> {
    const login = this.users.parseLoginOrFail(dto.login);
    const user = await this.users.verifyCredentials(login, dto.password, dto.totpCode);
    await this.users.touchLogin(user.id);
    const tenants = await this.users.listTenants(user.id);
    const only = tenants.length === 1 ? tenants[0] : null;
    const tokens = await this.sessions.create(
      user.id,
      only ? { tenantId: only.tenantId, membershipId: only.membershipId } : null,
      meta,
    );
    return { tokens, user: this.users.toPublic(user), tenants, currentTenantId: only?.tenantId ?? null };
  }

  /** Выбор магазина: новый токен на этот магазин (ТЗ 3.2). */
  async selectTenant(userId: string, sessionId: string, tenantId: string): Promise<AuthResult> {
    const tenants = await this.users.listTenants(userId);
    const t = tenants.find((x) => x.tenantId === tenantId);
    if (!t) throw Errors.notFound('Магазин');
    const tokens = await this.sessions.switchTenant(sessionId, t.tenantId, t.membershipId);
    const user = await this.users.getById(userId);
    return { tokens, user: this.users.toPublic(user), tenants, currentTenantId: t.tenantId };
  }

  async refresh(refreshToken: string | undefined, meta: ClientMeta) {
    if (!refreshToken) throw Errors.unauthorized('Нет refresh-токена', 'NO_REFRESH_TOKEN');
    const res = await this.sessions.refresh(refreshToken, meta);
    // Участие могли отключить — тогда сессия теряет магазин
    if (res.session.tenantId && res.session.membershipId) {
      const m = await this.access.load(res.session.tenantId, res.session.membershipId, res.session.userId);
      if (!m || m.status !== 'active') {
        const tokens = await this.sessions.switchTenant(res.session.id, null, null);
        return { tokens, tenantDropped: true };
      }
    }
    return { tokens: res as IssuedTokens, tenantDropped: false };
  }

  async changePassword(userId: string, sessionId: string, oldPassword: string, newPassword: string) {
    await this.users.verifyPasswordOnly(userId, oldPassword);
    await this.users.setPassword(userId, newPassword);
    await this.sessions.revokeAllForUser(userId, 'password_changed', sessionId);
  }

  // ── Приглашения ─────────────────────────────────────────

  private async findInvitation(code: string): Promise<Invitation | null> {
    const codeHash = sha256(code.trim().toUpperCase());
    return this.platform.transaction(async (m) => {
      await m.query(`SELECT set_config('app.invite_code_hash', $1, true)`, [codeHash]);
      // Исключение из правила TenantRepository: магазин ещё неизвестен, строку пропускает политика RLS invitations_by_code
      // eslint-disable-next-line no-restricted-syntax
      return m.getRepository(Invitation).findOne({ where: { codeHash } });
    });
  }

  private assertInvitationUsable(inv: Invitation | null): asserts inv is Invitation {
    if (!inv || inv.revokedAt) throw Errors.notFound('Приглашение');
    if (inv.acceptedAt) throw Errors.conflict('INVITE_USED', 'Приглашение уже использовано');
    if (inv.expiresAt < new Date()) throw Errors.conflict('INVITE_EXPIRED', 'Срок приглашения истёк');
  }

  /** Публичный просмотр приглашения: какой магазин и какие роли. */
  async previewInvite(code: string) {
    const inv = await this.findInvitation(code);
    this.assertInvitationUsable(inv);
    const tenant = await this.platform.repo(Tenant).findOne({ where: { id: inv.tenantId } });
    const roles = await this.tenantTx.run(
      (tx) => (inv.roleIds.length ? tx.repo(Role).getByIds(inv.roleIds).catch(() => []) : Promise.resolve([])),
      { tenantId: inv.tenantId, userId: null },
    );
    return {
      tenantName: tenant?.name,
      roles: roles.map((r) => r.name),
      name: inv.name,
      loginRequired: inv.login ? maskLogin(inv.login) : null,
      expiresAt: inv.expiresAt,
    };
  }

  /**
   * Принять приглашение. Учётная запись есть → проверяем пароль и создаём только участие.
   * Нет → создаём учётную запись с этим паролем.
   */
  async acceptInvite(dto: AcceptInviteDto, meta: ClientMeta): Promise<AuthResult> {
    const inv = await this.findInvitation(dto.code);
    this.assertInvitationUsable(inv);
    const login = this.users.parseLoginOrFail(dto.login);
    if (inv.login && inv.login !== this.users.loginString(login)) {
      throw Errors.forbidden('Приглашение выписано на другой телефон или email');
    }

    let user: User;
    const existing = await this.users.findByLogin(login);
    if (existing) {
      user = await this.users.verifyCredentials(login, dto.password, dto.totpCode);
    } else {
      const name = dto.name ?? inv.name;
      if (!name) throw Errors.bad('NAME_REQUIRED', 'Укажите имя');
      user = await this.users.create({ name, login, password: dto.password });
    }

    const membershipId = await this.tenantTx.run(
      async (tx) => {
        const locked = await tx.repo(Invitation).getById(inv.id, { lock: { mode: 'pessimistic_write' } } as any);
        this.assertInvitationUsable(locked);

        let membership = await tx.repo(Membership).findOne({ where: { userId: user.id } });
        if (membership?.status === 'active') {
          throw Errors.conflict('ALREADY_MEMBER', 'Вы уже сотрудник этого магазина');
        }
        if (membership) {
          membership.status = 'active';
          membership.disabledAt = null;
          membership.allStores = locked.allStores;
          membership.position = locked.position;
          membership.accessVersion += 1;
          membership = await tx.repo(Membership).save(membership);
          await tx.repo(MembershipRole).hardDelete({ membershipId: membership.id });
          await tx.repo(MembershipStoreAccess).hardDelete({ membershipId: membership.id });
        } else {
          membership = await tx.repo(Membership).insert({
            userId: user.id,
            status: 'active',
            isOwner: false,
            allStores: locked.allStores,
            position: locked.position,
          });
        }

        const roles = await tx.repo(Role).findByIds(locked.roleIds);
        const assignable = roles.filter((r) => r.code !== 'owner');
        await tx.repo(MembershipRole).insertMany(assignable.map((r) => ({ membershipId: membership!.id, roleId: r.id })));
        if (!locked.allStores && locked.storeIds.length) {
          const stores = await tx.repo(Store).findByIds(locked.storeIds);
          await tx
            .repo(MembershipStoreAccess)
            .insertMany(stores.map((s) => ({ membershipId: membership!.id, storeId: s.id })));
        }

        locked.acceptedAt = new Date();
        locked.acceptedBy = user.id;
        await tx.repo(Invitation).save(locked);

        await this.audit.log(tx, {
          action: 'member.join',
          entityType: 'membership',
          entityId: membership.id,
          summary: `${user.name} принял(а) приглашение`,
          important: true,
        });
        return membership.id;
      },
      { tenantId: inv.tenantId, userId: user.id },
    );

    this.access.invalidateMembership(membershipId);
    await this.users.touchLogin(user.id);
    const tokens = await this.sessions.create(user.id, { tenantId: inv.tenantId, membershipId }, meta);
    return this.result(user, tokens, inv.tenantId);
  }

  private async result(user: User, tokens: IssuedTokens, tenantId: string | null): Promise<AuthResult> {
    const tenants = await this.users.listTenants(user.id);
    return { tokens, user: this.users.toPublic(user), tenants, currentTenantId: tenantId };
  }
}

function maskLogin(login: string) {
  if (login.includes('@')) {
    const [a, b] = login.split('@');
    return `${a.slice(0, 2)}***@${b}`;
  }
  return `+${login.slice(0, 3)} *** ** ${login.slice(-2)}`;
}

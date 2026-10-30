import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { extractBearer } from '../../common/guards/jwt-auth.guard';
import { SecretBox } from '../../common/utils/secret-box';
import { normalizeBrand } from '../../common/utils/brand';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TokenService } from '../auth/token.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../telegram/telegram.service';
import { importVehicles } from '../vehicles/vehicles-import';
import { PlatformAdmin, PlatformAdminLog, SupportGrant, SupportSession } from './entities/admin.entity';

export const ADMIN_ROLE = 'adminRole';
export const AdminRole = (role: 'admin' | 'support') => SetMetadata(ADMIN_ROLE, role);

export interface AdminUser {
  id: string;
  role: 'admin' | 'support';
  name: string;
}

const SUPPORT_MINUTES = 60;

/** Guard админки: токен сотрудника платформы (отдельный ключ), роль. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
    private readonly platform: PlatformDb,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = extractBearer(req);
    const p = token ? this.tokens.verifyPlatform(token, `${this.config.jwtAccessSecret}:admin`, 'admin') : null;
    if (!p) throw Errors.unauthorized('Войдите в админку платформы', 'ADMIN_UNAUTHORIZED');
    const a = await this.platform.repo(PlatformAdmin).findOne({ where: { id: p.sub } });
    if (!a?.isActive) throw Errors.unauthorized('Учётная запись отключена', 'ADMIN_UNAUTHORIZED');
    const need = this.reflector.getAllAndOverride<string>(ADMIN_ROLE, [ctx.getHandler(), ctx.getClass()]);
    if (need === 'admin' && a.role !== 'admin') throw Errors.forbidden('Только администратор платформы');
    req.admin = { id: a.id, role: a.role, name: a.name } as AdminUser;
    return true;
  }
}

/**
 * Админка платформы (ТЗ 24): магазины и подписка вручную, общие справочники, мониторинг,
 * вход поддержки с согласием владельца. Пароли, PIN и токены магазинов сотрудникам не видны;
 * их действия — в отдельном неизменяемом журнале.
 */
@Injectable()
export class AdminService {
  private readonly box: SecretBox;

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenantTx: TenantTransaction,
    private readonly tokens: TokenService,
    private readonly config: AppConfig,
    private readonly notifications: NotificationsService,
    private readonly telegram: TelegramService,
    private readonly ctx: RequestContext,
  ) {
    this.box = new SecretBox(config.encryptionKey);
  }

  async log(admin: AdminUser, action: string, tenantId: string | null, details: Record<string, unknown> = {}) {
    await this.platform.repo(PlatformAdminLog).insert({ adminId: admin.id, action, tenantId, details: details as any, ip: this.ctx.get('ip') ?? null });
  }

  // ── Учётные записи ───────────────────────────────────────

  /** Создать сотрудника платформы (скрипт admin:create): пароль + секрет TOTP для приложения. */
  async createAdmin(email: string, name: string, password: string, role: 'admin' | 'support') {
    if (password.length < 10) throw new Error('Пароль — от 10 символов');
    const secret = authenticator.generateSecret();
    const a = await this.platform.repo(PlatformAdmin).save({ email: email.toLowerCase(), name, role, passwordHash: await bcrypt.hash(password, 12), totpSecretEnc: this.box.encrypt(secret) } as any);
    return { id: a.id, otpauthUrl: authenticator.keyuri(email, 'Autoparts Admin', secret), secret };
  }

  /** Вход: пароль + код из приложения (двухфакторная обязательна). 5 ошибок — блокировка на 15 минут. */
  async login(email: string, password: string, code: string) {
    const repo = this.platform.repo(PlatformAdmin);
    const a = await repo.createQueryBuilder('a').addSelect(['a.passwordHash', 'a.totpSecretEnc']).where('a.email = :e', { e: email.toLowerCase() }).getOne();
    if (!a || !a.isActive) {
      await bcrypt.compare(password, '$2b$12$abcdefghijklmnopqrstuuDXvCzsQ2F3bqHT3Y6Wq3R7dGJQ1z7pS');
      throw Errors.unauthorized('Неверный вход', 'ADMIN_LOGIN_FAILED');
    }
    if (a.lockedUntil && a.lockedUntil > new Date()) throw Errors.tooMany('Слишком много попыток, подождите 15 минут');
    const ok = (await bcrypt.compare(password, a.passwordHash)) && authenticator.check(String(code ?? '').trim(), this.box.decrypt(a.totpSecretEnc));
    if (!ok) {
      const failed = a.failedLogins + 1;
      await repo.update({ id: a.id }, { failedLogins: failed >= 5 ? 0 : failed, lockedUntil: failed >= 5 ? new Date(Date.now() + 15 * 60_000) : null });
      throw Errors.unauthorized('Неверный вход', 'ADMIN_LOGIN_FAILED');
    }
    await repo.update({ id: a.id }, { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() });
    await this.log({ id: a.id, role: a.role, name: a.name }, 'admin.login', null);
    return { accessToken: this.tokens.signPlatform({ sub: a.id, typ: 'admin' }, `${this.config.jwtAccessSecret}:admin`, '8h'), admin: { id: a.id, name: a.name, role: a.role } };
  }

  // ── Магазины и подписка ──────────────────────────────────

  private async stats(tenantId: string) {
    return this.tenantTx.run(
      async (tx) => {
        const [r] = await tx.query(
          `SELECT (SELECT count(*)::int FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL) AS stores,
                  (SELECT count(*)::int FROM registers WHERE tenant_id = $1) AS registers,
                  (SELECT count(*)::int FROM memberships WHERE tenant_id = $1 AND status = 'active') AS staff,
                  (SELECT count(*)::int FROM products WHERE tenant_id = $1 AND deleted_at IS NULL) AS products,
                  (SELECT max(created_at) FROM audit_log WHERE tenant_id = $1) AS "lastActivity",
                  (SELECT count(*)::int FROM receipts WHERE tenant_id = $1 AND created_at > now() - interval '30 days') AS "receipts30d"`,
          [tenantId],
        );
        return r;
      },
      { tenantId, userId: null },
    );
  }

  async tenants(q: { search?: string; status?: string }) {
    const rows = await this.platform.ds.query(
      `SELECT t.id, t.name, t.shop_type AS "shopType", t.city, t.phone, t.status, t.plan, t.limits, t.subscription_until AS "subscriptionUntil", t.created_at AS "createdAt",
              u.name AS "ownerName", u.phone AS "ownerPhone"
         FROM tenants t LEFT JOIN users u ON u.id = t.owner_user_id
        WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR u.phone LIKE '%' || $1 || '%') AND ($2::text IS NULL OR t.status = $2)
        ORDER BY t.created_at DESC LIMIT 500`,
      [q.search ?? null, q.status ?? null],
    );
    for (const r of rows) Object.assign(r, await this.stats(r.id));
    return rows;
  }

  async tenant(id: string) {
    const [t] = await this.platform.ds.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    if (!t) throw Errors.notFound('Магазин');
    const support = await this.platform.repo(SupportSession).find({ where: { tenantId: id }, order: { createdAt: 'DESC' }, take: 20 });
    return { ...t, ...(await this.stats(id)), support };
  }

  /** Подписка вручную: статус, дата окончания, тариф и лимиты, заметка об оплате. */
  async setSubscription(admin: AdminUser, id: string, dto: { status?: 'trial' | 'active' | 'suspended'; subscriptionUntil?: string | null; plan?: string; limits?: Record<string, number>; note?: string }) {
    const [t] = await this.platform.ds.query(`SELECT status, plan, limits, subscription_until FROM tenants WHERE id = $1`, [id]);
    if (!t) throw Errors.notFound('Магазин');
    await this.platform.ds.query(
      `UPDATE tenants SET status = coalesce($2, status), subscription_until = CASE WHEN $3::boolean THEN $4::timestamptz ELSE subscription_until END,
              plan = coalesce($5, plan), limits = coalesce($6::jsonb, limits), updated_at = now() WHERE id = $1`,
      [id, dto.status ?? null, dto.subscriptionUntil !== undefined, dto.subscriptionUntil ?? null, dto.plan ?? null, dto.limits ? JSON.stringify(dto.limits) : null],
    );
    await this.log(admin, 'tenant.subscription', id, { before: t, after: dto });
    return this.tenant(id);
  }

  // ── Общие справочники ────────────────────────────────────

  async dictionary(kind: 'makes' | 'brands' | 'synonyms' | 'wmi', q?: string) {
    const sql = {
      makes: `SELECT id, code, name, aliases FROM global_vehicle_makes WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%') ORDER BY name LIMIT 500`,
      brands: `SELECT id, name, aliases, country, is_car_maker AS "isCarMaker" FROM global_brands WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%') ORDER BY name LIMIT 500`,
      synonyms: `SELECT * FROM global_search_synonyms WHERE ($1::text IS NULL OR word ILIKE '%' || $1 || '%') ORDER BY 1 LIMIT 500`,
      wmi: `SELECT w.*, m.name AS make FROM global_vin_wmi w LEFT JOIN global_vehicle_makes m ON m.id = w.make_id WHERE ($1::text IS NULL OR w.wmi ILIKE $1 || '%') ORDER BY w.wmi LIMIT 500`,
    }[kind];
    return this.platform.ds.query(sql, [q ?? null]);
  }

  async saveDictionary(admin: AdminUser, kind: 'makes' | 'brands' | 'synonyms' | 'wmi', row: Record<string, any>) {
    let res;
    if (kind === 'makes') {
      [res] = await this.platform.ds.query(
        `INSERT INTO global_vehicle_makes (code, name, aliases) VALUES (lower($1), $2, $3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, aliases = EXCLUDED.aliases, updated_at = now() RETURNING *`,
        [row.code, row.name, row.aliases ?? []],
      );
    } else if (kind === 'wmi') {
      const [m] = await this.platform.ds.query(`SELECT id FROM global_vehicle_makes WHERE code = lower($1)`, [row.make]);
      if (!m) throw Errors.bad('MAKE_NOT_FOUND', 'Марка не найдена');
      [res] = await this.platform.ds.query(
        `INSERT INTO global_vin_wmi (wmi, make_id, country) VALUES (upper($1), $2, $3) ON CONFLICT (wmi) DO UPDATE SET make_id = EXCLUDED.make_id, country = EXCLUDED.country RETURNING *`,
        [row.wmi, m.id, row.country ?? null],
      );
    } else if (kind === 'brands') {
      [res] = await this.platform.ds.query(
        `INSERT INTO global_brands (name, normalized_name, aliases, aliases_norm, is_car_maker, country) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name, aliases = EXCLUDED.aliases, aliases_norm = EXCLUDED.aliases_norm, country = EXCLUDED.country, updated_at = now() RETURNING *`,
        [row.name, normalizeBrand(row.name), row.aliases ?? [], (row.aliases ?? []).map((a: string) => normalizeBrand(a)), !!row.isCarMaker, row.country ?? null],
      );
    } else {
      [res] = await this.platform.ds.query(`INSERT INTO global_search_synonyms (word, target, lang) VALUES (lower($1), lower($2), coalesce($3, 'ru')) ON CONFLICT (word, target) DO NOTHING RETURNING *`, [row.word, row.target, row.lang ?? null]);
    }
    await this.log(admin, `dictionary.${kind}`, null, row);
    return res ?? { ok: true };
  }

  async importVehicles(admin: AdminUser, file: Express.Multer.File) {
    if (!file) throw Errors.bad('NO_FILE', 'Файл не передан');
    const tmp = `/tmp/vehicles-${Date.now()}.${file.originalname.endsWith('.xlsx') ? 'xlsx' : 'csv'}`;
    await (await import('fs/promises')).writeFile(tmp, file.buffer);
    const stats = await importVehicles(this.platform.ds, tmp);
    await (await import('fs/promises')).unlink(tmp).catch(() => undefined);
    await this.log(admin, 'dictionary.vehicles_import', null, stats);
    return stats;
  }

  // ── Мониторинг ───────────────────────────────────────────

  async monitoring() {
    const tenants = await this.platform.ds.query(`SELECT id, name FROM tenants WHERE status <> 'deleted' ORDER BY name`);
    const [outbox] = await this.platform.ds.query(`SELECT count(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed, count(*) FILTER (WHERE processed_at IS NULL)::int AS pending FROM outbox_events`).catch(() => [{ failed: null, pending: null }]);
    const perTenant = [];
    for (const t of tenants) {
      const r = await this.tenantTx.run(
        async (tx) => {
          const [x] = await tx.query(
            `SELECT (SELECT count(*)::int FROM devices WHERE tenant_id = $1 AND kind = 'pos' AND revoked_at IS NULL AND last_seen_at > coalesce(last_sync_at, 'epoch') + interval '30 minutes') AS "offlineUnsent",
                    (SELECT count(*)::int FROM import_jobs WHERE tenant_id = $1 AND status IN ('running', 'queued', 'processing') AND updated_at < now() - interval '1 hour') AS "stuckImports",
                    (SELECT count(*)::int FROM notifications WHERE tenant_id = $1 AND type = 'stock.reconcile_mismatch' AND created_at > now() - interval '2 days') AS "stockMismatches",
                    (SELECT round(100.0 * count(*) FILTER (WHERE found_count > 0) / nullif(count(*), 0)) FROM ocr_recognitions WHERE tenant_id = $1 AND created_at > now() - interval '30 days') AS "ocrFoundRate"`,
            [t.id],
          );
          return x;
        },
        { tenantId: t.id, userId: null },
      );
      if (r.offlineUnsent || r.stuckImports || r.stockMismatches || (r.ocrFoundRate !== null && Number(r.ocrFoundRate) < 60)) perTenant.push({ tenantId: t.id, name: t.name, ...r });
    }
    return { outbox, problems: perTenant, checkedTenants: tenants.length };
  }

  journal(q: { adminId?: string; tenantId?: string }) {
    return this.platform.ds.query(
      `SELECT l.*, a.name AS "adminName" FROM platform_admin_log l LEFT JOIN platform_admins a ON a.id = l.admin_id
        WHERE ($1::uuid IS NULL OR l.admin_id = $1) AND ($2::uuid IS NULL OR l.tenant_id = $2) ORDER BY l.created_at DESC LIMIT 500`,
      [q.adminId ?? null, q.tenantId ?? null],
    );
  }

  // ── Вход поддержки ───────────────────────────────────────

  private async notifyOwners(tenantId: string, title: string, body?: string) {
    await this.tenantTx.run((tx) => this.notifications.notify(tx, { type: 'staff.changed', title, body, ownersOnly: true, link: '/settings/support' }), { tenantId, userId: null });
    const owners = await this.platform.ds.query(
      `SELECT u.telegram_chat_id AS chat FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE t.id = $1 AND u.telegram_chat_id IS NOT NULL`,
      [tenantId],
    );
    for (const o of owners) await this.telegram.send(o.chat, `🛟 ${title}${body ? `\n${body}` : ''}`);
  }

  private token(s: SupportSession) {
    return this.tokens.signPlatform({ sub: s.adminId, typ: 'support', ssid: s.id, tid: s.tenantId }, `${this.config.jwtAccessSecret}:support`, `${SUPPORT_MINUTES}m`);
  }

  /**
   * Запросить вход: есть разрешение владельца на 24 часа — сеанс сразу (права из разрешения);
   * иначе — запрос владельцу; аварийно (emergency) — сразу, с причиной и немедленным уведомлением.
   */
  async requestSupport(admin: AdminUser, tenantId: string, dto: { reason: string; emergency?: boolean; canWrite?: boolean }) {
    const repo = this.platform.repo(SupportSession);
    const grant = await this.platform.ds.query(`SELECT * FROM support_grants WHERE tenant_id = $1 AND revoked_at IS NULL AND until > now() ORDER BY until DESC LIMIT 1`, [tenantId]).then((r) => r[0]);
    const now = new Date();
    const active = !!grant || !!dto.emergency;
    const s = await repo.save({
      tenantId,
      adminId: admin.id,
      status: active ? 'active' : 'requested',
      reason: dto.reason.slice(0, 500),
      emergency: !!dto.emergency && !grant,
      canWrite: grant ? grant.can_write && !!dto.canWrite : false,
      showMoney: grant ? grant.show_money : false,
      startedAt: active ? now : null,
      expiresAt: active ? new Date(now.getTime() + SUPPORT_MINUTES * 60_000) : null,
    } as any);
    await this.log(admin, dto.emergency ? 'support.emergency' : 'support.request', tenantId, { sessionId: s.id, reason: dto.reason });
    if (s.emergency) await this.notifyOwners(tenantId, 'Аварийный вход поддержки в магазин', `Причина: ${dto.reason}. Только просмотр, 60 минут. Завершить — в настройках, «Поддержка».`);
    else if (!active) await this.notifyOwners(tenantId, 'Поддержка просит доступ к магазину', `Причина: ${dto.reason}. Разрешить — в настройках, «Поддержка».`);
    else await this.notifyOwners(tenantId, 'Поддержка вошла в магазин (по вашему разрешению)', dto.reason);
    return { session: s, ...(active ? { supportToken: this.token(s), expiresAt: s.expiresAt } : {}) };
  }

  /** Токен для подтверждённого владельцем запроса. */
  async enterSupport(admin: AdminUser, sessionId: string) {
    const s = await this.platform.repo(SupportSession).findOne({ where: { id: sessionId, adminId: admin.id } });
    if (!s || s.status !== 'active' || !s.expiresAt || s.expiresAt < new Date()) throw Errors.bad('SUPPORT_NOT_ACTIVE', 'Сеанс не подтверждён владельцем или уже завершён');
    return { supportToken: this.token(s), expiresAt: s.expiresAt, canWrite: s.canWrite, showMoney: s.showMoney };
  }

  async endSupport(admin: AdminUser, sessionId: string) {
    await this.platform.ds.query(`UPDATE support_sessions SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = $1 AND admin_id = $2 AND status IN ('active', 'requested')`, [sessionId, admin.id]);
    await this.log(admin, 'support.end', null, { sessionId });
    return { ended: true };
  }
}

/** Владелец магазина: разрешение поддержке на 24 часа, подтверждение запросов, завершение сеанса. */
@Injectable()
export class SupportOwnerService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly ctx: RequestContext,
  ) {}

  private assertOwner() {
    if (!this.ctx.isOwner) throw Errors.forbidden('Только владелец');
  }

  async state() {
    this.assertOwner();
    const tenantId = this.ctx.requireTenantId();
    const grant = (await this.platform.ds.query(`SELECT id, until, can_write AS "canWrite", show_money AS "showMoney" FROM support_grants WHERE tenant_id = $1 AND revoked_at IS NULL AND until > now() ORDER BY until DESC LIMIT 1`, [tenantId]))[0] ?? null;
    const sessions = await this.platform.ds.query(
      `SELECT s.id, s.status, s.reason, s.emergency, s.can_write AS "canWrite", s.show_money AS "showMoney", s.started_at AS "startedAt", s.expires_at AS "expiresAt", s.created_at AS "createdAt", a.name AS "adminName"
         FROM support_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.tenant_id = $1 ORDER BY s.created_at DESC LIMIT 30`,
      [tenantId],
    );
    /** Баннер «Сеанс поддержки» у владельца */
    const active = sessions.filter((s: any) => s.status === 'active' && new Date(s.expiresAt) > new Date());
    return { grant, sessions, activeSession: active[0] ?? null };
  }

  async grant(dto: { hours?: number; canWrite?: boolean; showMoney?: boolean }) {
    this.assertOwner();
    const tenantId = this.ctx.requireTenantId();
    await this.platform.ds.query(`UPDATE support_grants SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenantId]);
    await this.platform.repo(SupportGrant).save({ tenantId, grantedBy: this.ctx.userId!, until: new Date(Date.now() + Math.min(dto.hours ?? 24, 72) * 3600_000), canWrite: !!dto.canWrite, showMoney: !!dto.showMoney } as any);
    return this.state();
  }

  async revoke() {
    this.assertOwner();
    const tenantId = this.ctx.requireTenantId();
    await this.platform.ds.query(`UPDATE support_grants SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenantId]);
    await this.platform.ds.query(`UPDATE support_sessions SET status = 'ended', ended_at = now() WHERE tenant_id = $1 AND status IN ('active', 'requested')`, [tenantId]);
    return this.state();
  }

  async approve(id: string, dto: { canWrite?: boolean; showMoney?: boolean }) {
    this.assertOwner();
    const tenantId = this.ctx.requireTenantId();
    const [rows] = await this.platform.ds.query(
      `UPDATE support_sessions SET status = 'active', approved_by = $3, can_write = $4, show_money = $5, started_at = now(), expires_at = now() + interval '${SUPPORT_MINUTES} minutes', updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'requested' RETURNING id`,
      [id, tenantId, this.ctx.userId, !!dto.canWrite, !!dto.showMoney],
    );
    if (!rows?.length) throw Errors.notFound('Запрос');
    return this.state();
  }

  async decline(id: string) {
    this.assertOwner();
    await this.platform.ds.query(`UPDATE support_sessions SET status = 'declined', ended_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'requested'`, [id, this.ctx.requireTenantId()]);
    return this.state();
  }
}

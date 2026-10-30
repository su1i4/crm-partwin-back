import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RequestContext } from '../context/request-context';
import { ALLOW_NO_TENANT, ALLOW_SUSPENDED, AuthUser, IS_PUBLIC } from '../decorators/auth.decorators';
import { AppException, Errors } from '../errors/app.exception';
import { AccessService } from '../../modules/auth/access.service';
import { TokenService } from '../../modules/auth/token.service';
import { isUuid } from '../../database/tenant/tenant-repository';
import { HttpStatus } from '@nestjs/common';
import { AppConfig } from '../../config/app.config';
import { PlatformDb } from '../../database/tenant/platform-db';
import { ALL_PERMISSIONS } from '../../modules/roles/permissions';

export function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/**
 * Глобальный guard: проверяет токен, сессию, участие в магазине и заполняет контекст запроса
 * (пользователь, магазин, права, доступные точки) для TenantTransaction и ScopeService.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly access: AccessService,
    private readonly ctx: RequestContext,
    private readonly platform: PlatformDb,
    private readonly config: AppConfig,
  ) {}

  private async supportSession(req: Request & { authUser?: AuthUser }, ssid: string, adminId: string) {
    const [s] = await this.platform.ds.query(
      `SELECT id, tenant_id, can_write, show_money FROM support_sessions WHERE id = $1 AND admin_id = $2 AND status = 'active' AND expires_at > now()`,
      [ssid, adminId],
    );
    if (!s) throw Errors.unauthorized('Сеанс поддержки завершён', 'SUPPORT_SESSION_ENDED');
    if (!s.can_write && req.method !== 'GET') throw Errors.forbidden('Сеанс поддержки — только просмотр');
    const hidden = ['products.view_cost', 'money.read', 'money.write', 'money.verify_transfers', 'reports.money', 'reports.profit', 'dashboard.owner'];
    this.ctx.set('tenantId', s.tenant_id);
    this.ctx.set('supportSessionId', s.id);
    this.ctx.set('supportCanWrite', s.can_write);
    this.ctx.set('isOwner', false);
    this.ctx.set('permissions', ALL_PERMISSIONS.filter((p) => s.show_money || !hidden.includes(p)));
    this.ctx.set('storeIds', null);
    this.ctx.set('warehouseIds', null);
    const storeHeader = req.headers['x-store-id'];
    if (typeof storeHeader === 'string' && isUuid(storeHeader)) this.ctx.set('currentStoreId', storeHeader);
    req.authUser = { userId: adminId, sessionId: s.id, tenantId: s.tenant_id, isOwner: false } as AuthUser;
    return true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const req = context.switchToHttp().getRequest<Request & { authUser?: AuthUser }>();

    const token = extractBearer(req);
    if (!token) {
      if (isPublic) return true;
      throw Errors.unauthorized();
    }
    // Сеанс поддержки платформы: только с согласия владельца, по умолчанию — чтение (ТЗ 24)
    const sup = this.tokens.verifyPlatform(token, `${this.config.jwtAccessSecret}:support`, 'support');
    if (sup?.ssid) return this.supportSession(req, sup.ssid, sup.sub);
    const payload = this.tokens.verifyAccess(token);
    if (!payload) {
      if (isPublic) return true;
      throw Errors.unauthorized('Сессия истекла, войдите снова', 'TOKEN_EXPIRED');
    }

    const session = await this.access.getSession(payload.sid);
    if (!session || session.revokedAt || session.userId !== payload.sub || session.expiresAt < new Date()) {
      throw Errors.unauthorized('Сессия завершена, войдите снова', 'SESSION_REVOKED');
    }

    this.ctx.set('userId', payload.sub);
    this.ctx.set('sessionId', payload.sid);
    const authUser: AuthUser = { userId: payload.sub, sessionId: payload.sid, isOwner: false };

    if (payload.tid && payload.mid) {
      const tenant = await this.access.getTenant(payload.tid);
      if (!tenant) throw Errors.unauthorized('Магазин не найден', 'TENANT_NOT_FOUND');
      const m = await this.access.getMembershipAccess(payload.tid, payload.mid, payload.sub);
      if (!m || m.status !== 'active') {
        throw Errors.unauthorized('Доступ к магазину отключён', 'MEMBERSHIP_DISABLED');
      }

      this.ctx.set('tenantId', payload.tid);
      this.ctx.set('membershipId', payload.mid);
      this.ctx.set('isOwner', m.isOwner);
      this.ctx.set('permissions', m.permissions);
      this.ctx.set('storeIds', m.allStores ? null : m.storeIds);
      this.ctx.set('warehouseIds', m.warehouseIds.length ? m.warehouseIds : null);
      this.ctx.set('tenantStatus', tenant.status);
      this.ctx.set('maxDiscountPercent', m.maxDiscountPercent);
      Object.assign(authUser, { tenantId: payload.tid, membershipId: payload.mid, isOwner: m.isOwner });

      // Приостановленная подписка — только просмотр и выгрузка (ТЗ 24)
      const allowSuspended = this.reflector.getAllAndOverride<boolean>(ALLOW_SUSPENDED, targets);
      if (tenant.status === 'suspended' && req.method !== 'GET' && !allowSuspended) {
        throw new AppException(
          'TENANT_SUSPENDED',
          'Подписка приостановлена: доступен только просмотр и выгрузка',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // Текущая точка из заголовка
      const storeHeader = req.headers['x-store-id'];
      if (typeof storeHeader === 'string' && storeHeader) {
        if (!isUuid(storeHeader) || (!m.allStores && !m.storeIds.includes(storeHeader))) {
          throw Errors.forbidden('Нет доступа к выбранной точке');
        }
        this.ctx.set('currentStoreId', storeHeader);
      }
    } else if (!isPublic) {
      const allowNoTenant = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_TENANT, targets);
      if (!allowNoTenant) throw Errors.forbidden('Сначала выберите магазин');
    }

    req.authUser = authUser;
    return true;
  }
}

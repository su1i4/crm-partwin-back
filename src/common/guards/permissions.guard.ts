import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '../context/request-context';
import { PERMISSIONS_KEY, PERMISSIONS_MODE } from '../decorators/auth.decorators';
import { AppException } from '../errors/app.exception';
import { HttpStatus } from '@nestjs/common';

/** Проверка разрешений @RequirePermission / @RequireAnyPermission (ТЗ 2.4.11). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContext,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    if (!required?.length) return true;
    if (!this.ctx.tenantId) throw new AppException('FORBIDDEN', 'Сначала выберите магазин', HttpStatus.FORBIDDEN);
    const mode = this.reflector.getAllAndOverride<'all' | 'any'>(PERMISSIONS_MODE, targets) ?? 'all';
    const ok = mode === 'all' ? required.every((p) => this.ctx.can(p)) : required.some((p) => this.ctx.can(p));
    if (!ok) {
      throw new AppException('FORBIDDEN', 'Недостаточно прав для этого действия', HttpStatus.FORBIDDEN, {
        required,
        mode,
      });
    }
    return true;
  }
}

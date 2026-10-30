import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse } from '@nestjs/swagger';
import type { Permission } from '../../modules/roles/permissions';

export const IS_PUBLIC = 'isPublic';
export const ALLOW_NO_TENANT = 'allowNoTenant';
export const PERMISSIONS_KEY = 'permissions';
export const PERMISSIONS_MODE = 'permissionsMode';
export const ALLOW_SUSPENDED = 'allowSuspended';

/** Эндпоинт без авторизации. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Доступно с токеном, в котором ещё не выбран магазин (выбор магазина, профиль). */
export const AllowNoTenant = () => SetMetadata(ALLOW_NO_TENANT, true);

/** Разрешено при приостановленной подписке (кроме GET, которые разрешены всегда). */
export const AllowWhenSuspended = () => SetMetadata(ALLOW_SUSPENDED, true);

/** Требуются ВСЕ перечисленные разрешения (ТЗ 2.4.11). */
export const RequirePermission = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE, 'all'),
    ApiBearerAuth(),
    ApiForbiddenResponse({ description: `Нужны разрешения: ${permissions.join(', ')}` }),
  );

/** Достаточно ЛЮБОГО из перечисленных разрешений. */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE, 'any'),
    ApiBearerAuth(),
    ApiForbiddenResponse({ description: `Нужно одно из разрешений: ${permissions.join(', ')}` }),
  );

export interface AuthUser {
  userId: string;
  sessionId: string;
  tenantId?: string;
  membershipId?: string;
  isOwner: boolean;
}

/** Текущий пользователь из токена. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.authUser;
});

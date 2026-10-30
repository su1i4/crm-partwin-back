import { Injectable } from '@nestjs/common';
import { ClsService, ClsStore } from 'nestjs-cls';
import type { TenantTx } from '../../database/tenant/tenant-tx';

/** Что лежит в контексте запроса (nestjs-cls). */
export interface AppClsStore extends ClsStore {
  requestId?: string;
  ip?: string;
  userAgent?: string;

  userId?: string;
  sessionId?: string;
  tenantId?: string;
  membershipId?: string;
  deviceId?: string;
  /** Сеанс поддержки платформы (ТЗ 24) */
  supportSessionId?: string;
  supportCanWrite?: boolean;

  isOwner?: boolean;
  permissions?: string[];
  /** null — доступ ко всем точкам */
  storeIds?: string[] | null;
  /** null — все склады разрешённых точек */
  warehouseIds?: string[] | null;
  /** Точка, выбранная в интерфейсе (заголовок X-Store-Id) */
  currentStoreId?: string;
  maxDiscountPercent?: number;
  tenantStatus?: string;

  /** Текущая транзакция магазина (TenantTransaction) */
  tx?: TenantTx;
}

/** Типизированная обёртка над ClsService. */
@Injectable()
export class RequestContext {
  constructor(readonly cls: ClsService) {}

  get active() {
    return this.cls.isActive();
  }
  get<K extends keyof AppClsStore>(key: K): AppClsStore[K] | undefined {
    return this.cls.isActive() ? (this.cls.get(key as any) as AppClsStore[K]) : undefined;
  }
  set<K extends keyof AppClsStore>(key: K, value: AppClsStore[K]) {
    this.cls.set(key as any, value as any);
  }

  get userId() {
    return this.get('userId');
  }
  get tenantId() {
    return this.get('tenantId');
  }
  get membershipId() {
    return this.get('membershipId');
  }
  get sessionId() {
    return this.get('sessionId');
  }
  get isOwner() {
    return this.get('isOwner') === true;
  }
  get permissions(): string[] {
    return this.get('permissions') ?? [];
  }
  get tx() {
    return this.get('tx');
  }

  requireTenantId(): string {
    const t = this.tenantId;
    if (!t) throw new Error('Нет текущего магазина в контексте запроса');
    return t;
  }

  /** Есть ли у текущего пользователя разрешение. Владелец — всё. */
  can(permission: string): boolean {
    if (this.isOwner) return true;
    const perms = this.permissions;
    return perms.includes('*') || perms.includes(permission);
  }
}

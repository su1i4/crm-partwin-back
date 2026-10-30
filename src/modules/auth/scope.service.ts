import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { TenantTx } from '../../database/tenant/tenant-tx';

/**
 * Ограничение доступа по точкам и складам (ТЗ 3.4).
 * Действует везде: списки, карточки, поиск, отчёты, экспорт, печать, WebSocket, уведомления.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly ctx: RequestContext) {}

  /** null — все точки; иначе список разрешённых. */
  storeIds(): string[] | null {
    const v = this.ctx.get('storeIds');
    return v === undefined ? null : v;
  }

  hasAllStores(): boolean {
    return this.storeIds() === null;
  }

  canStore(storeId: string | null | undefined): boolean {
    const ids = this.storeIds();
    if (ids === null) return true;
    if (!storeId) return false; // центральные склады и объекты без точки — только при доступе ко всем
    return ids.includes(storeId);
  }

  /** Нет доступа — 404 (не раскрываем существование). */
  assertStore(storeId: string | null | undefined) {
    if (!this.canStore(storeId)) throw Errors.notFound('Точка');
  }

  /** Явно разрешённые склады (сужение), null — без сужения. */
  explicitWarehouseIds(): string[] | null {
    const v = this.ctx.get('warehouseIds');
    return v === undefined || v === null || v.length === 0 ? null : v;
  }

  /** Склады, доступные текущему пользователю. null — все. */
  async warehouseIds(tx: TenantTx): Promise<string[] | null> {
    const explicit = this.explicitWarehouseIds();
    const stores = this.storeIds();
    if (stores === null && explicit === null) return null;
    const rows = await tx.query<{ id: string }>(
      `SELECT id FROM warehouses
        WHERE tenant_id = $1 AND deleted_at IS NULL
          AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [tx.tenantId, stores, explicit],
    );
    return rows.map((r) => r.id);
  }

  async assertWarehouse(tx: TenantTx, warehouseId: string) {
    const allowed = await this.warehouseIds(tx);
    if (allowed !== null && !allowed.includes(warehouseId)) throw Errors.notFound('Склад');
  }

  /** SQL-условие для выборок: `${alias}.store_id = ANY(...)`. Пусто, если доступ ко всем. */
  storeCondition(column: string, paramName = 'scopeStoreIds'): { sql: string; params: Record<string, unknown> } {
    const ids = this.storeIds();
    if (ids === null) return { sql: '1=1', params: {} };
    return { sql: `${column} = ANY(:${paramName})`, params: { [paramName]: ids } };
  }

  /** Текущая точка из заголовка X-Store-Id (уже проверена на доступ). */
  currentStoreId(): string | undefined {
    return this.ctx.get('currentStoreId');
  }
}

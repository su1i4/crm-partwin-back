import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { TenantRepository } from './tenant-repository';

/** Открытая транзакция конкретного магазина. app.tenant_id уже выставлен (RLS). */
export class TenantTx {
  constructor(
    readonly manager: EntityManager,
    readonly tenantId: string,
    readonly userId: string | null,
  ) {}

  repo<T extends ObjectLiteral & { id: string; tenantId: string }>(
    entity: EntityTarget<T>,
    entityName?: string,
  ): TenantRepository<T> {
    return new TenantRepository<T>(entity, (fn) => fn(this), entityName);
  }

  /** Сырой SQL внутри транзакции магазина. Условие tenant_id пишите сами — RLS подстрахует. */
  query<R = any>(sql: string, params: unknown[] = []): Promise<R[]> {
    return this.manager.query(sql, params);
  }

  /**
   * То же, что query, но всегда возвращает строки: драйвер pg для UPDATE/DELETE … RETURNING
   * отдаёт [строки, количество].
   */
  async rows<R = any>(sql: string, params: unknown[] = []): Promise<R[]> {
    const res: any = await this.manager.query(sql, params);
    return Array.isArray(res) && res.length === 2 && Array.isArray(res[0]) && typeof res[1] === 'number' ? res[0] : res;
  }

  /** Кэш на время транзакции (бренды при импорте и т.п.) */
  readonly memo = new Map<string, unknown>();

  /** Колбэки, которые выполнятся после успешного COMMIT. */
  readonly afterCommit: Array<() => void | Promise<void>> = [];
  onCommit(fn: () => void | Promise<void>) {
    this.afterCommit.push(fn);
  }
}

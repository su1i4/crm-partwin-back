import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DataSource, EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';
import { TenantRepository } from './tenant-repository';
import { TenantTx } from './tenant-tx';

export interface TenantRunOptions {
  /** Явно указать магазин (фоновые задачи, регистрация). По умолчанию — из контекста запроса. */
  tenantId?: string;
  userId?: string | null;
  isolation?: IsolationLevel;
}

/**
 * Единственная точка входа в данные магазина (ТЗ 2.4.5).
 * В начале транзакции — SET LOCAL app.tenant_id / app.user_id, дальше работают RLS-политики.
 * Вложенный вызов для того же магазина переиспользует текущую транзакцию.
 */
@Injectable()
export class TenantTransaction {
  private readonly logger = new Logger(TenantTransaction.name);

  constructor(
    private readonly ds: DataSource,
    private readonly cls: ClsService,
  ) {}

  async run<R>(fn: (tx: TenantTx) => Promise<R>, opts: TenantRunOptions = {}): Promise<R> {
    const ctxActive = this.cls.isActive();
    const existing = ctxActive ? this.cls.get('tx') : undefined;
    // Фоновая задача: магазин задан во внешнем run({ tenantId }) — вложенные вызовы берут его из открытой транзакции
    const tenantId = opts.tenantId ?? (ctxActive ? (this.cls.get('tenantId') ?? existing?.tenantId) : undefined);
    if (!tenantId) throw new Error('TenantTransaction: не задан магазин (tenant_id)');
    const userId = opts.userId !== undefined ? opts.userId : ctxActive ? (this.cls.get('userId') ?? existing?.userId ?? null) : null;

    if (existing) {
      if (existing.tenantId !== tenantId) {
        throw new Error('TenantTransaction: вложенная транзакция другого магазина запрещена');
      }
      return fn(existing);
    }

    const execute = async () => {
      let tx!: TenantTx;
      const result = await this.ds.transaction(opts.isolation ?? 'READ COMMITTED', async (manager) => {
        tx = await this.bind(manager, tenantId, userId);
        this.cls.set('tx', tx);
        try {
          return await fn(tx);
        } finally {
          this.cls.set('tx', undefined);
        }
      });
      await this.flushAfterCommit(tx);
      return result;
    };

    // Вне HTTP-запроса (фоновые задачи) — создаём контекст; внутри — наследуем
    return this.cls.run({ ifNested: 'inherit' }, execute);
  }

  /** Использовать уже открытую транзакцию (например, при регистрации нового магазина). */
  async runInManager<R>(
    manager: EntityManager,
    tenantId: string,
    userId: string | null,
    fn: (tx: TenantTx) => Promise<R>,
  ): Promise<R> {
    const tx = await this.bind(manager, tenantId, userId);
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('tx', tx);
      try {
        return await fn(tx);
      } finally {
        this.cls.set('tx', undefined);
      }
    });
  }

  /** Репозиторий, каждый вызов которого откроет (или переиспользует) транзакцию магазина. */
  repo<T extends ObjectLiteral & { id: string; tenantId: string }>(
    entity: EntityTarget<T>,
    entityName?: string,
  ): TenantRepository<T> {
    return new TenantRepository<T>(entity, (fn) => this.run(fn), entityName);
  }

  private async bind(manager: EntityManager, tenantId: string, userId: string | null) {
    await manager.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`,
      [tenantId, userId ?? ''],
    );
    return new TenantTx(manager, tenantId, userId);
  }

  private async flushAfterCommit(tx: TenantTx | undefined) {
    if (!tx) return;
    for (const cb of tx.afterCommit) {
      try {
        await cb();
      } catch (e) {
        this.logger.error(`afterCommit: ${(e as Error).message}`);
      }
    }
  }
}

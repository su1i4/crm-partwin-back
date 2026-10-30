import {
  DeepPartial,
  EntityManager,
  EntityTarget,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  In,
  IsNull,
  ObjectLiteral,
  SelectQueryBuilder,
} from 'typeorm';
import { Errors } from '../../common/errors/app.exception';
import type { TenantTx } from './tenant-tx';

type TenantRow = ObjectLiteral & { id: string; tenantId: string };

/**
 * Репозиторий данных магазина (ТЗ 2.4.5).
 *  - сам добавляет tenant_id в каждую выборку и при вставке;
 *  - любой id с клиента загружается через getById(): чужой или несуществующий → 404;
 *  - всегда работает внутри TenantTransaction (там выставлен app.tenant_id для RLS).
 *
 * Получить: `tx.repo(Product)` внутри транзакции или `tenantTx.repo(Product)` вне её
 * (тогда каждый вызов сам откроет короткую транзакцию).
 */
export class TenantRepository<T extends TenantRow> {
  constructor(
    private readonly entity: EntityTarget<T>,
    private readonly exec: <R>(fn: (tx: TenantTx) => Promise<R>) => Promise<R>,
    private readonly entityName = 'Объект',
  ) {}

  private repoOf(manager: EntityManager) {
    // eslint-disable-next-line no-restricted-syntax -- единственное разрешённое место: ниже проверка tenantId
    const repo = manager.getRepository(this.entity);
    if (!repo.metadata.findColumnWithPropertyName('tenantId')) {
      throw new Error(`${repo.metadata.name} не является таблицей магазина (нет tenantId)`);
    }
    return repo;
  }

  private scopeWhere(where: FindManyOptions<T>['where'], tenantId: string): FindManyOptions<T>['where'] {
    if (Array.isArray(where)) {
      // Пустой OR-список не должен превращаться в «все строки»
      if (where.length === 0) return { tenantId, id: IsNull() } as unknown as FindOptionsWhere<T>;
      return where.map((w) => ({ ...w, tenantId }) as FindOptionsWhere<T>);
    }
    return { ...(where ?? {}), tenantId } as FindOptionsWhere<T>;
  }

  find(options: FindManyOptions<T> = {}): Promise<T[]> {
    return this.exec((tx) =>
      this.repoOf(tx.manager).find({ ...options, where: this.scopeWhere(options.where, tx.tenantId) }),
    );
  }

  findAndCount(options: FindManyOptions<T> = {}): Promise<[T[], number]> {
    return this.exec((tx) =>
      this.repoOf(tx.manager).findAndCount({ ...options, where: this.scopeWhere(options.where, tx.tenantId) }),
    );
  }

  count(options: FindManyOptions<T> = {}): Promise<number> {
    return this.exec((tx) =>
      this.repoOf(tx.manager).count({ ...options, where: this.scopeWhere(options.where, tx.tenantId) }),
    );
  }

  findOne(options: FindOneOptions<T>): Promise<T | null> {
    return this.exec((tx) =>
      this.repoOf(tx.manager).findOne({
        ...options,
        where: this.scopeWhere(options.where, tx.tenantId) as FindOneOptions<T>['where'],
      }),
    );
  }

  findById(id: string, options: Omit<FindOneOptions<T>, 'where'> = {}): Promise<T | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.findOne({ ...options, where: { id } as FindOptionsWhere<T> });
  }

  /** Загрузить по id с клиента. Нет или чужой → 404. */
  async getById(id: string, options: Omit<FindOneOptions<T>, 'where'> = {}): Promise<T> {
    const row = await this.findById(id, options);
    if (!row) throw Errors.notFound(this.entityName);
    return row;
  }

  /** Загрузить список id с клиента. Хотя бы одного нет → 404. */
  async getByIds(ids: string[]): Promise<T[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    if (!unique.every(isUuid)) throw Errors.notFound(this.entityName);
    const rows = await this.find({ where: { id: In(unique) } as FindOptionsWhere<T> });
    if (rows.length !== unique.length) throw Errors.notFound(this.entityName);
    return rows;
  }

  /** Найти существующие из списка id (без 404; чужие и несуществующие просто не вернутся). */
  findByIds(ids: string[], options: Omit<FindManyOptions<T>, 'where'> = {}): Promise<T[]> {
    const unique = [...new Set(ids)].filter(isUuid);
    if (unique.length === 0) return Promise.resolve([]);
    return this.find({ ...options, where: { id: In(unique) } as FindOptionsWhere<T> });
  }

  /** Создать и сохранить (tenant_id и created_by проставляются сами). */
  insert(data: DeepPartial<T>): Promise<T> {
    return this.exec(async (tx) => {
      const repo = this.repoOf(tx.manager);
      const row = repo.create({ ...data, tenantId: tx.tenantId, createdBy: tx.userId ?? null } as DeepPartial<T>);
      return repo.save(row);
    });
  }

  insertMany(data: DeepPartial<T>[]): Promise<T[]> {
    if (data.length === 0) return Promise.resolve([]);
    return this.exec(async (tx) => {
      const repo = this.repoOf(tx.manager);
      const rows = data.map((d) =>
        repo.create({ ...d, tenantId: tx.tenantId, createdBy: tx.userId ?? null } as DeepPartial<T>),
      );
      return repo.save(rows, { chunk: 500 });
    });
  }

  /** Сохранить загруженную через этот репозиторий сущность. */
  save(entity: T): Promise<T> {
    return this.exec(async (tx) => {
      if (entity.tenantId && entity.tenantId !== tx.tenantId) throw Errors.notFound(this.entityName);
      (entity as any).tenantId = tx.tenantId;
      return this.repoOf(tx.manager).save(entity);
    });
  }

  /**
   * Изменить с оптимистичной блокировкой (ТЗ 2.4.12).
   * expectedVersion — версия, которую видел клиент. Не совпала → 409 VERSION_CONFLICT.
   */
  update(id: string, patch: DeepPartial<T>, expectedVersion?: number): Promise<T> {
    return this.exec(async (tx) => {
      const repo = this.repoOf(tx.manager);
      const current = await this.getById(id, { lock: { mode: 'pessimistic_write' } } as any);
      const hasVersion = !!repo.metadata.versionColumn;
      if (hasVersion && expectedVersion !== undefined && (current as any).version !== expectedVersion) {
        throw Errors.versionConflict();
      }
      const { id: _i, tenantId: _t, createdAt: _c, createdBy: _cb, version: _v, ...rest } = patch as any;
      const safe = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      repo.merge(current, safe as DeepPartial<T>);
      return repo.save(current);
    });
  }

  /** Загрузить с блокировкой строки до конца транзакции и проверить версию, которую видел клиент. */
  getForUpdate(id: string, expectedVersion?: number): Promise<T> {
    return this.exec(async () => {
      const current = await this.getById(id, { lock: { mode: 'pessimistic_write' } } as any);
      if (expectedVersion !== undefined && (current as any).version !== expectedVersion) throw Errors.versionConflict();
      return current;
    });
  }

  /** Мягкое удаление (только справочники и документы). */
  softDelete(id: string, expectedVersion?: number): Promise<void> {
    return this.exec(async (tx) => {
      const repo = this.repoOf(tx.manager);
      if (!repo.metadata.deleteDateColumn) throw new Error(`${repo.metadata.name}: нет deleted_at`);
      const current = await this.getById(id);
      if (expectedVersion !== undefined && (current as any).version !== expectedVersion) {
        throw Errors.versionConflict();
      }
      await repo.softDelete({ id, tenantId: tx.tenantId } as FindOptionsWhere<T>);
    });
  }

  /** Физическое удаление (связующие таблицы, черновики без истории). */
  hardDelete(where: FindOptionsWhere<T>): Promise<number> {
    return this.exec(async (tx) => {
      const res = await this.repoOf(tx.manager).delete({ ...where, tenantId: tx.tenantId } as FindOptionsWhere<T>);
      return res.affected ?? 0;
    });
  }

  /**
   * QueryBuilder с уже наложенным условием tenant_id на основную таблицу.
   * Используйте внутри tx.run(...): `await tenantTx.run(tx => tx.repo(X).qb('x').where(...).getMany())`.
   */
  qb(tx: TenantTx, alias: string): SelectQueryBuilder<T> {
    return this.repoOf(tx.manager)
      .createQueryBuilder(alias)
      .where(`${alias}.tenant_id = :__tenantId`, { __tenantId: tx.tenantId });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

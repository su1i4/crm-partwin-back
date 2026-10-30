import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, ObjectLiteral, Repository } from 'typeorm';

/**
 * Доступ к платформенным таблицам без tenant_id: users, tenants, user_sessions, global_*.
 * Для таблиц магазина использовать НЕЛЬЗЯ — только TenantTransaction.
 */
@Injectable()
export class PlatformDb {
  constructor(readonly ds: DataSource) {}

  repo<T extends ObjectLiteral>(entity: EntityTarget<T>): Repository<T> {
    // eslint-disable-next-line no-restricted-syntax
    const repo = this.ds.getRepository(entity);
    if (repo.metadata.findColumnWithPropertyName('tenantId') && !PLATFORM_TABLES_WITH_TENANT.has(repo.metadata.tableName)) {
      throw new Error(`${repo.metadata.name} — таблица магазина, используйте TenantTransaction`);
    }
    return repo;
  }

  /** Платформенный репозиторий внутри уже открытой транзакции. */
  repoIn<T extends ObjectLiteral>(manager: EntityManager, entity: EntityTarget<T>): Repository<T> {
    this.repo(entity); // проверка, что таблица платформенная
    // eslint-disable-next-line no-restricted-syntax
    return manager.getRepository(entity);
  }

  transaction<R>(fn: (manager: EntityManager) => Promise<R>): Promise<R> {
    return this.ds.transaction(fn);
  }
}

/** Платформенные таблицы, у которых есть tenant_id как ссылка, но нет RLS. */
const PLATFORM_TABLES_WITH_TENANT = new Set(['user_sessions', 'outbox_events', 'device_pairing_codes', 'customer_telegram', 'platform_admin_log', 'support_sessions', 'support_grants']);

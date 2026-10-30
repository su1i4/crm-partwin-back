import './pg-types';
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

loadEnv();

/** Общие опции. Сущности — по glob-шаблону, только миграции (synchronize: false). */
export function baseDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    uuidExtension: 'pgcrypto', // gen_random_uuid()
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'typeorm_migrations',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    migrationsRun: false,
  };
}

/**
 * Источник данных для CLI миграций — под ролью-владельцем (DATABASE_OWNER_URL).
 * npm run migration:generate -- src/database/migrations/Name
 */
const AppDataSource = new DataSource(
  baseDataSourceOptions(process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL ?? ''),
);
export default AppDataSource;

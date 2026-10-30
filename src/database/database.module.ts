import './pg-types';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from '../config/app.config';
import { baseDataSourceOptions } from './data-source';
import { DbChecksService } from './db-checks.service';
import { PlatformDb } from './tenant/platform-db';
import { TenantTransaction } from './tenant/tenant-transaction';

/** Подключение приложения — под ролью autoparts_app (без BYPASSRLS). */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (c: AppConfig) => ({
        ...baseDataSourceOptions(c.databaseUrl),
        logging: c.dbLogging ? ['query', 'error'] : ['error'],
        extra: { max: c.dbPoolSize, application_name: 'autoparts-crm' },
      }),
    }),
  ],
  providers: [TenantTransaction, PlatformDb, DbChecksService],
  exports: [TenantTransaction, PlatformDb],
})
export class DatabaseModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController, SupportOwnerController } from './admin.controller';
import { AdminGuard, AdminService, SupportOwnerService } from './admin.service';
import { TenantExportService } from './tenant-export.service';

/** Админка платформы, вход поддержки, полная выгрузка магазина (этап 10). */
@Module({
  imports: [AuthModule],
  controllers: [AdminController, SupportOwnerController],
  providers: [AdminService, AdminGuard, SupportOwnerService, TenantExportService],
  exports: [AdminService, TenantExportService],
})
export class AdminModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ContextModule } from './common/context/context.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { JobsModule } from './jobs/jobs.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { CounterpartiesModule } from './modules/counterparties/counterparties.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { DevicesModule } from './modules/devices/devices.module';
import { FinanceModule } from './modules/finance/finance.module';
import { PosModule } from './modules/pos/pos.module';
import { OfflineModule } from './modules/offline/offline.module';
import { OcrModule } from './modules/ocr/ocr.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { StoModule } from './modules/sto/sto.module';
import { WholesaleModule } from './modules/wholesale/wholesale.module';
import { StorageModule } from './modules/storage/storage.module';
import { AdminModule } from './modules/admin/admin.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { ImportsModule } from './modules/imports/imports.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PartsModule } from './modules/parts/parts.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { SearchModule } from './modules/search/search.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RolesModule } from './modules/roles/roles.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StoresModule } from './modules/stores/stores.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';

@Module({
  imports: [
    AppConfigModule,
    ContextModule,
    DatabaseModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
    JobsModule,
    RealtimeModule,
    AuditModule,
    NotificationsModule,
    SettingsModule,
    TenantsModule,
    AuthModule,
    RolesModule,
    UsersModule,
    StoresModule,
    FilesModule,
    PricingModule,
    CatalogModule,
    PartsModule,
    VehiclesModule,
    SearchModule,
    ImportsModule,
    CounterpartiesModule,
    DocumentsModule,
    FinanceModule,
    DevicesModule,
    PosModule,
    OfflineModule,
    OcrModule,
    TelegramModule,
    ReportsModule,
    LoyaltyModule,
    StoModule,
    WholesaleModule,
    StorageModule,
    AdminModule,
    PurchasingModule,
    OnboardingModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}

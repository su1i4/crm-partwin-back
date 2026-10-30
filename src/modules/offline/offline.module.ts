import { Module } from '@nestjs/common';
import { OfflineCacheService } from './offline-cache.service';
import { OfflineController } from './offline.controller';
import { OfflineSalesService } from './offline-sales.service';
import { OfflineSyncService } from './offline-sync.service';
import { PosDevicesService } from './pos-devices.service';

/** Касса без интернета (этап 5): устройства, кэш кассы, приём офлайн-очереди. */
@Module({
  controllers: [OfflineController],
  providers: [PosDevicesService, OfflineCacheService, OfflineSalesService, OfflineSyncService],
})
export class OfflineModule {}

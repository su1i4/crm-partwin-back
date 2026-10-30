import { Global, Module } from '@nestjs/common';
import { ApplicabilityService } from './applicability.service';
import { CatalogTreeService } from './catalog-tree.service';
import { VehicleDirectoryService } from './vehicle-directory.service';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { VinService } from './vin.service';

@Global()
@Module({
  controllers: [VehiclesController],
  providers: [VehicleDirectoryService, ApplicabilityService, VehiclesService, CatalogTreeService, VinService],
  exports: [VehicleDirectoryService, ApplicabilityService, VinService],
})
export class VehiclesModule {}

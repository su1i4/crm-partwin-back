import { Global, Module } from '@nestjs/common';
import { TenantBootstrapService } from './tenant-bootstrap.service';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Global()
@Module({
  controllers: [TenantsController],
  providers: [TenantsService, TenantBootstrapService],
  exports: [TenantsService, TenantBootstrapService],
})
export class TenantsModule {}

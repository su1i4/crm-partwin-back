import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowWhenSuspended, RequirePermission } from '../../common/decorators/auth.decorators';
import { UpdateTenantDto } from './dto/tenant.dto';
import { TenantsService } from './tenants.service';

@ApiTags('Аккаунт магазина')
@ApiBearerAuth()
@Controller('tenant')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @AllowWhenSuspended()
  @ApiOperation({ summary: 'Данные магазина: название, реквизиты, подписка' })
  async get() {
    return this.tenants.view(await this.tenants.current());
  }

  @Patch()
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Изменить данные магазина' })
  update(@Body() dto: UpdateTenantDto) {
    return this.tenants.update(dto);
  }
}

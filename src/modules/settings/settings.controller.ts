import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateSettingsDto } from './dto/settings.dto';
import { SettingsService } from './settings.service';
import { RequirePermission } from '../../common/decorators/auth.decorators';

@ApiTags('Настройки магазина')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Настройки магазина (с версией)' })
  get() {
    return this.settings.getWithVersion();
  }

  @Patch()
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Изменить настройки (частично). Видно в журнале, уведомление администраторам' })
  update(@Body() dto: UpdateSettingsDto) {
    return this.settings.update(dto);
  }
}

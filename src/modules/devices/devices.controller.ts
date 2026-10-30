import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Public, RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { DevicesService } from './devices.service';

class PairingCodeDto {
  @ApiProperty() @IsUUID() registerId: string;
}
class PairDto {
  @ApiProperty({ example: '482913' }) @IsString() @Length(6, 8) code: string;
  @ApiPropertyOptional({ example: 'Касса у входа' }) @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional({ example: '1.0.0' }) @IsOptional() @IsString() @Length(1, 30) agentVersion?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() info?: Record<string, any>;
}
class HeartbeatDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 30) agentVersion?: string;
  @ApiPropertyOptional({ description: 'Принтеры, ящик, журнал — для диагностики' }) @IsOptional() @IsObject() info?: Record<string, any>;
}
class JobStatusDto {
  @ApiProperty({ enum: ['printed', 'no_paper', 'not_found', 'offline', 'error'] }) @IsIn(['printed', 'no_paper', 'not_found', 'offline', 'error']) status: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) error?: string;
}
class PrintJobDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiProperty({ enum: ['drawer', 'test'] }) @IsIn(['drawer', 'test']) kind: 'drawer' | 'test';
}

const tokenOf = (auth?: string, header?: string) => (header ?? auth?.replace(/^Device\s+/i, '') ?? '').trim();

@ApiTags('Оборудование и агент печати')
@Controller()
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly tenantTx: TenantTransaction,
  ) {}

  @Post('devices/pairing-code')
  @RequirePermission('devices.manage')
  @ApiOperation({ summary: '«Подключить агент»: 6-значный код на 10 минут' })
  pairingCode(@Body() dto: PairingCodeDto) {
    return this.devices.pairingCode(dto.registerId);
  }

  @Get('devices')
  @RequireAnyPermission('devices.manage', 'pos.use')
  list(@Query('registerId') registerId?: string) {
    return this.devices.list(registerId);
  }

  @Delete('devices/:id')
  @HttpCode(204)
  @RequirePermission('devices.manage')
  @ApiOperation({ summary: 'Отозвать токен агента' })
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.devices.revoke(id);
  }

  @Post('print-jobs')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Открыть денежный ящик / тестовая печать' })
  printJob(@Body() dto: PrintJobDto) {
    return this.tenantTx.run((tx) => this.devices.enqueue(tx, dto.registerId, dto.kind, {}));
  }

  @Get('print-jobs/:id')
  @RequirePermission('pos.use')
  job(@Param('id', ParseUUIDPipe) id: string) {
    return this.devices.job(id);
  }

  // ── API самого агента (токен устройства: Authorization: Device <token> или X-Device-Token) ──

  @Public()
  @Post('agent/pair')
  @ApiOperation({ summary: 'Агент: ввести код привязки → токен устройства' })
  pair(@Body() dto: PairDto) {
    return this.devices.pair(dto);
  }

  @Public()
  @Post('agent/heartbeat')
  @ApiHeader({ name: 'X-Device-Token', required: false })
  heartbeat(@Headers('authorization') auth: string, @Headers('x-device-token') token: string, @Body() dto: HeartbeatDto) {
    return this.devices.heartbeat(tokenOf(auth, token), dto);
  }

  @Public()
  @Get('agent/jobs')
  @ApiOperation({ summary: 'Агент: забрать задания печати (если WebSocket недоступен)' })
  pull(@Headers('authorization') auth: string, @Headers('x-device-token') token: string) {
    return this.devices.pull(tokenOf(auth, token));
  }

  @Public()
  @Post('agent/jobs/:id/status')
  @ApiOperation({ summary: 'Агент: статус задания (Напечатано, Нет бумаги, Принтер не найден)' })
  status(@Headers('authorization') auth: string, @Headers('x-device-token') token: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JobStatusDto) {
    return this.devices.reportStatus(tokenOf(auth, token), id, dto);
  }
}

import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Length, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { Public, RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { OfflineCacheService } from './offline-cache.service';
import { OP_TYPES, OfflineSyncService } from './offline-sync.service';
import { PosDevicesService } from './pos-devices.service';

class RegisterPosDeviceDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiPropertyOptional({ example: 'Телефон Айбека' }) @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional({ example: { platform: 'android', browser: 'chrome' } }) @IsOptional() @IsObject() info?: Record<string, any>;
}
class PinLoginDto {
  @ApiProperty({ example: '48291' }) @IsString() @Length(4, 8) pin: string;
}
class OfflineOpDto {
  @ApiProperty({ description: 'UUID операции (у чека — UUID чека)' }) @IsUUID() id: string;
  @ApiProperty({ example: 1, description: 'Порядковый номер в очереди устройства' }) @IsInt() @Min(1) seq: number;
  @ApiProperty({ enum: OP_TYPES }) @IsIn(OP_TYPES) type: (typeof OP_TYPES)[number];
  @ApiProperty({ description: 'Время на устройстве' }) @IsISO8601() at: string;
  @ApiProperty({ description: 'Продавец, выполнивший операцию' }) @IsUUID() membershipId: string;
  @ApiProperty({ description: 'Данные операции (чек, смена, клиент …)' }) @IsObject() payload: Record<string, any>;
}
class SyncDto {
  @ApiPropertyOptional({ description: 'Время на устройстве в момент отправки — для поправки на сбитые часы' }) @IsOptional() @IsISO8601() deviceTime?: string;
  @ApiProperty({ type: [OfflineOpDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => OfflineOpDto) ops: OfflineOpDto[];
}

const tok = (h?: string) => h?.trim();

@ApiTags('Касса без интернета')
@Controller()
export class OfflineController {
  constructor(
    private readonly devices: PosDevicesService,
    private readonly cache: OfflineCacheService,
    private readonly sync: OfflineSyncService,
    private readonly tenantTx: TenantTransaction,
  ) {}

  @Post('pos-devices')
  @RequirePermission('devices.manage')
  @ApiOperation({ summary: 'Привязать этот браузер/телефон к кассе: токен устройства, секрет и серия номеров (показываются один раз)' })
  register(@Body() dto: RegisterPosDeviceDto) {
    return this.devices.register(dto);
  }

  @Get('pos-devices')
  @RequireAnyPermission('devices.manage', 'pos.use')
  list(@Query('registerId') registerId?: string) {
    return this.devices.list(registerId);
  }

  @Delete('pos-devices/:id')
  @HttpCode(204)
  @RequirePermission('devices.manage')
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.devices.revoke(id);
  }

  // ── API кассового устройства (заголовок X-Device-Token) ──

  @Public()
  @Post('pos-device/pin-login')
  @ApiHeader({ name: 'X-Device-Token', required: true })
  @ApiOperation({ summary: 'Вход продавца по PIN на зарегистрированной кассе' })
  pinLogin(@Headers('x-device-token') token: string, @Body() dto: PinLoginDto, @Req() req: Request) {
    return this.devices.pinLogin(tok(token), dto.pin, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  }

  @Public()
  @Get('pos-device/cache')
  @ApiHeader({ name: 'X-Device-Token', required: true })
  @ApiOperation({ summary: 'Кэш кассы: без cursor — полностью, с cursor — изменения с прошлой синхронизации' })
  getCache(@Headers('x-device-token') token: string, @Query('cursor') cursor?: string) {
    return this.cache.build(tok(token), cursor ?? null);
  }

  @Public()
  @Post('pos-device/sync')
  @ApiHeader({ name: 'X-Device-Token', required: true })
  @ApiOperation({ summary: 'Очередь офлайн-операций: строго по порядку, каждая — один раз' })
  postSync(@Headers('x-device-token') token: string, @Body() dto: SyncDto) {
    return this.sync.sync(tok(token), dto);
  }

  @Public()
  @Get('pos-device/sync/state')
  @ApiHeader({ name: 'X-Device-Token', required: true })
  @ApiOperation({ summary: 'Что сервер уже принял: последняя операция и отклонённые' })
  state(@Headers('x-device-token') token: string) {
    return this.sync.state(tok(token));
  }

  // ── Отчёты ───────────────────────────────────────────────

  @Get('pos/reports/stale-prices')
  @RequireAnyPermission('reports.sales', 'prices.write')
  @ApiOperation({ summary: '«Продажи по устаревшей цене» — офлайн-чеки, где цена изменилась, пока касса была без сети' })
  stalePrices() {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT r.id AS "receiptId", r.number, r.completed_at AS "date", r.device_created_at AS "deviceAt", l.product_id AS "productId",
                coalesce(l.extra->>'name', p.name) AS name, l.qty, (l.extra->'stalePrice'->>'soldAt')::numeric AS "soldAt",
                (l.extra->'stalePrice'->>'current')::numeric AS current
           FROM receipts r JOIN document_lines l ON l.tenant_id = r.tenant_id AND l.document_id = r.document_id JOIN products p ON p.id = l.product_id
          WHERE r.tenant_id = $1 AND r.offline AND l.extra ? 'stalePrice' ORDER BY r.completed_at DESC LIMIT 500`,
        [tx.tenantId],
      ),
    );
  }

  @Get('pos/reports/offline')
  @RequireAnyPermission('reports.sales', 'money.read')
  @ApiOperation({ summary: 'Офлайн-чеки с пометками: минус, долг сверх лимита, сбитые часы, закрытый период' })
  offline() {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT r.id, r.number, r.kind, r.total, r.device_created_at AS "deviceAt", r.received_at AS "receivedAt", r.completed_at AS "completedAt", r.flags, d.name AS device
           FROM receipts r LEFT JOIN devices d ON d.id = r.device_id
          WHERE r.tenant_id = $1 AND r.offline ORDER BY r.received_at DESC LIMIT 500`,
        [tx.tenantId],
      ),
    );
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { CatalogTreeService } from './catalog-tree.service';
import {
  ApplicabilityBulkDto,
  ApplicabilityCopyDto,
  ApplicabilityReplaceDto,
  CreateTenantGenerationDto,
  CreateTenantModelDto,
} from './dto/vehicles.dto';
import { VehiclesService } from './vehicles.service';
import { VinService } from './vin.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';

@ApiTags('Автомобили и применимость')
@Controller()
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly tree: CatalogTreeService,
    private readonly vin: VinService,
    private readonly tenantTx: TenantTransaction,
  ) {}

  @Get('catalog/fit-issues')
  @RequirePermission('products.read')
  @ApiQuery({ name: 'resolved', required: false, example: 'false' })
  @ApiOperation({ summary: '«Проверить применимость»: возвраты «не подошло» по товарам' })
  fitIssues(@Query('resolved') resolved?: string, @Query('productId') productId?: string) {
    return this.vehicles.fitIssues({ resolved: resolved === 'true', productId });
  }

  @Post('catalog/fit-issues/:id/resolve')
  @RequirePermission('products.write')
  @ApiOperation({ summary: 'Разобрано: применимость проверена / исправлена' })
  resolveFitIssue(@Param('id', ParseUUIDPipe) id: string, @Body() body: { note?: string }) {
    return this.vehicles.resolveFitIssue(id, body?.note);
  }

  @Get('vehicles/decode-vin')
  @RequirePermission('products.read')
  @ApiQuery({ name: 'vin', example: 'JTNBE40K803123456' })
  @ApiOperation({ summary: 'Расшифровка VIN: марка, год, модель (для известных марок), подходящие поколения' })
  decodeVin(@Query('vin') vin: string) {
    return this.tenantTx.run((tx) => this.vin.decode(tx, vin));
  }

  @Get('vehicles/body-code')
  @RequirePermission('products.read')
  @ApiQuery({ name: 'code', example: 'ACV40-1234567' })
  @ApiOperation({ summary: 'Код кузова / номер рамы японской машины → поколение и модификации' })
  bodyCode(@Query('code') code: string) {
    return this.tenantTx.run((tx) => this.vin.bodyCode(tx, code));
  }

  @Get('vehicles/makes')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Марки (общий справочник)' })
  makes() {
    return this.vehicles.makes();
  }

  @Get('vehicles/makes/:makeId/models')
  @RequirePermission('products.read')
  models(@Param('makeId', ParseUUIDPipe) makeId: string) {
    return this.vehicles.models(makeId);
  }

  @Get('vehicles/models/:modelId/generations')
  @RequirePermission('products.read')
  generations(@Param('modelId', ParseUUIDPipe) modelId: string) {
    return this.vehicles.generations(modelId);
  }

  @Get('vehicles/generations/:generationId/modifications')
  @RequirePermission('products.read')
  modifications(@Param('generationId', ParseUUIDPipe) id: string) {
    return this.vehicles.modifications(id);
  }

  @Get('vehicles/resolve')
  @RequirePermission('products.read')
  @ApiQuery({ name: 'q', example: 'камри 40' })
  @ApiOperation({ summary: 'Подсказки «Для каких машин»: «камри 40», «фит», «ACV40»' })
  resolve(@Query('q') q: string) {
    return this.vehicles.resolve(q ?? '');
  }

  @Post('vehicles/models')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Своя модель магазина (если нет в общем справочнике)' })
  createModel(@Body() dto: CreateTenantModelDto) {
    return this.vehicles.createModel(dto);
  }

  @Post('vehicles/generations')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Своё поколение магазина' })
  createGeneration(@Body() dto: CreateTenantGenerationDto) {
    return this.vehicles.createGeneration(dto);
  }

  @Get('catalog/tree/makes')
  @RequirePermission('products.read')
  @ApiQuery({ name: 'depth', required: false, enum: ['make', 'model', 'generation'] })
  @ApiOperation({ summary: 'Каталог «по маркам» с числом товаров' })
  treeByMakes(@Query('depth') depth?: 'make' | 'model' | 'generation') {
    return this.tree.byMakes(depth);
  }

  @Get('products/:id/applicability')
  @RequirePermission('products.read')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehicles.listApplicability(id);
  }

  @Put('products/:id/applicability')
  @RequireAnyPermission('products.write')
  @ApiOperation({ summary: 'Заменить применимость товара' })
  replace(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplicabilityReplaceDto) {
    return this.vehicles.replaceApplicability(id, dto.items);
  }

  @Post('products/:id/applicability/copy')
  @RequirePermission('products.write')
  @ApiOperation({ summary: '«Скопировать применимость с товара» в другие товары' })
  copy(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplicabilityCopyDto) {
    return this.vehicles.copy(id, dto.toProductIds);
  }

  @Post('products/applicability/bulk')
  @RequirePermission('products.import')
  @ApiOperation({ summary: 'Массово добавить применимость выбранным товарам' })
  bulk(@Body() dto: ApplicabilityBulkDto) {
    return this.vehicles.bulkAdd(dto.productIds, dto.items);
  }
}

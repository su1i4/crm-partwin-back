import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { WAREHOUSE_TYPE_LABELS } from './entities/warehouse.entity';
import {
  CreateRegisterDto,
  CreateStoreDto,
  CreateWarehouseDto,
  StoreFilterDto,
  UpdateRegisterDto,
  UpdateStoreDto,
  UpdateWarehouseDto,
} from './dto/stores.dto';
import { StoresService } from './stores.service';

@ApiTags('Точки, склады, кассы')
@ApiBearerAuth()
@Controller()
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly tenantTx: TenantTransaction,
  ) {}

  // Точки
  @Get('stores')
  @ApiOperation({ summary: 'Точки, доступные мне' })
  listStores(@Query() q: StoreFilterDto) {
    return this.stores.listStores(q.includeInactive);
  }

  @Get('stores/:id')
  getStore(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantTx.run((tx) => this.stores.getStore(tx, id));
  }

  @Post('stores')
  @RequirePermission('stores.manage')
  @ApiOperation({ summary: 'Создать точку (по умолчанию — с торговым залом и кассой)' })
  createStore(@Body() dto: CreateStoreDto) {
    return this.stores.createStore(dto);
  }

  @Patch('stores/:id')
  @RequirePermission('stores.manage')
  updateStore(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.updateStore(id, dto);
  }

  @Delete('stores/:id')
  @HttpCode(204)
  @RequirePermission('stores.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeStore(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.stores.removeStore(id, version);
  }

  // Склады
  @Get('warehouses/types')
  @ApiOperation({ summary: 'Типы складов' })
  warehouseTypes() {
    return Object.entries(WAREHOUSE_TYPE_LABELS).map(([code, label]) => ({ code, label }));
  }

  @Get('warehouses')
  @ApiOperation({ summary: 'Склады, доступные мне' })
  listWarehouses(@Query() q: StoreFilterDto) {
    return this.stores.listWarehouses(q.storeId, q.includeInactive);
  }

  @Post('warehouses')
  @RequirePermission('stores.manage')
  createWarehouse(@Body() dto: CreateWarehouseDto) {
    return this.stores.createWarehouse(dto);
  }

  @Patch('warehouses/:id')
  @RequirePermission('stores.manage')
  updateWarehouse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.stores.updateWarehouse(id, dto);
  }

  @Delete('warehouses/:id')
  @HttpCode(204)
  @RequirePermission('stores.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeWarehouse(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.stores.removeWarehouse(id, version);
  }

  // Кассы
  @Get('registers')
  @ApiOperation({ summary: 'Кассы, доступные мне' })
  listRegisters(@Query() q: StoreFilterDto) {
    return this.stores.listRegisters(q.storeId, q.includeInactive);
  }

  @Post('registers')
  @RequirePermission('stores.manage')
  @ApiOperation({ summary: 'Создать кассу (вторая касса переключает точку в режим «несколько касс»)' })
  createRegister(@Body() dto: CreateRegisterDto) {
    return this.stores.createRegister(dto);
  }

  @Patch('registers/:id')
  @RequirePermission('stores.manage')
  updateRegister(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRegisterDto) {
    return this.stores.updateRegister(id, dto);
  }

  @Delete('registers/:id')
  @HttpCode(204)
  @RequirePermission('stores.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeRegister(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.stores.removeRegister(id, version);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { PricesService } from '../pricing/prices.service';
import { CatalogOpsService } from './catalog-ops.service';
import { BulkUpdateDto, MergeDto } from './dto/dictionaries.dto';
import {
  BarcodeAddDto,
  CreateProductDto,
  PhotosDto,
  ProductListQueryDto,
  QuickCreateProductDto,
  SetPricesDto,
  UnitInputDto,
  UnitUpdateDto,
  UpdateProductDto,
} from './dto/product.dto';
import { QUALITY_LABELS } from './entities/product.entity';
import { ProductsQueryService } from './products-query.service';
import { ProductsService } from './products.service';

@ApiTags('Каталог: товары')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly query: ProductsQueryService,
    private readonly ops: CatalogOpsService,
    private readonly prices: PricesService,
    private readonly tenantTx: TenantTransaction,
  ) {}

  @Get()
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Каталог: фильтры по категории (с подкатегориями), бренду, машине, атрибутам, «чего не хватает»' })
  list(@Query() q: ProductListQueryDto) {
    return this.query.list(q);
  }

  @Get('meta')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Справочные значения: классы качества, единицы, типы цен' })
  meta() {
    return this.tenantTx.run(async (tx) => ({
      qualityClasses: Object.entries(QUALITY_LABELS).map(([code, label]) => ({ code, label })),
      baseUnits: ['шт', 'л', 'м', 'кг', 'компл', 'пара'],
      priceTypes: await this.prices.priceTypes(tx),
    }));
  }

  @Get('to-fill')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Отчёт «Дозаполнить»: без цены, остатка, фото, номера, категории, применимости' })
  toFill(@Query('page') page = '1', @Query('limit') limit = '50') {
    return this.ops.toFill(Math.max(1, Number(page) || 1), Math.min(500, Math.max(1, Number(limit) || 50)));
  }

  @Get('by-barcode/:code')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Товары по штрихкоду (несколько — окно выбора)' })
  byBarcode(@Param('code') code: string) {
    return this.products.byBarcode(code);
  }

  @Post()
  @RequirePermission('products.write')
  @ApiOperation({ summary: 'Создать товар (полная карточка)' })
  async create(@Body() dto: CreateProductDto) {
    const p = await this.products.create(dto);
    return this.products.card(p.id);
  }

  @Post('quick')
  @RequireAnyPermission('products.quick_create', 'products.write')
  @ApiOperation({ summary: 'Быстрое создание за 15 секунд: название, номер, бренд, цена, «для каких машин»' })
  quick(@Body() dto: QuickCreateProductDto) {
    return this.products.quickCreate(dto);
  }

  @Post('bulk')
  @RequirePermission('products.import')
  @ApiOperation({ summary: 'Массовое изменение по выбору или фильтру' })
  bulk(@Body() dto: BulkUpdateDto) {
    return this.ops.bulkUpdate(dto);
  }

  @Get(':id')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Карточка товара со всеми вкладками' })
  card(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.card(id);
  }

  @Patch(':id')
  @RequirePermission('products.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('products.write')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.archive(id, true);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('products.write')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.archive(id, false);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('products.write')
  @ApiQuery({ name: 'version', type: Number })
  @ApiOperation({ summary: 'Удалить (только без движений; иначе — архив)' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.products.remove(id, version);
  }

  @Post(':id/merge')
  @HttpCode(200)
  @RequirePermission('products.import')
  @ApiOperation({ summary: 'Объединить дубли в этот товар' })
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeDto) {
    return this.ops.merge(id, dto.duplicateIds);
  }

  // Единицы
  @Post(':id/units')
  @RequirePermission('products.write')
  @ApiOperation({ summary: 'Добавить упаковку: «упаковка = 4 шт»' })
  addUnit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UnitInputDto) {
    return this.products.addUnit(id, dto);
  }

  @Patch(':id/units/:unitId')
  @RequirePermission('products.write')
  updateUnit(@Param('id', ParseUUIDPipe) id: string, @Param('unitId', ParseUUIDPipe) unitId: string, @Body() dto: UnitUpdateDto) {
    return this.products.updateUnit(id, unitId, dto);
  }

  @Delete(':id/units/:unitId')
  @HttpCode(204)
  @RequirePermission('products.write')
  async archiveUnit(@Param('id', ParseUUIDPipe) id: string, @Param('unitId', ParseUUIDPipe) unitId: string) {
    await this.products.archiveUnit(id, unitId);
  }

  // Штрихкоды
  @Post(':id/barcodes')
  @RequireAnyPermission('products.write', 'stock.labels')
  @ApiOperation({ summary: 'Добавить штрихкод или выдать внутренний EAN-13' })
  addBarcode(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BarcodeAddDto) {
    return this.products.addBarcode(id, dto);
  }

  @Delete(':id/barcodes/:barcodeId')
  @HttpCode(204)
  @RequirePermission('products.write')
  async removeBarcode(@Param('id', ParseUUIDPipe) id: string, @Param('barcodeId', ParseUUIDPipe) barcodeId: string) {
    await this.products.removeBarcode(id, barcodeId);
  }

  // Фото и цены
  @Put(':id/photos')
  @RequirePermission('products.write')
  @ApiOperation({ summary: 'Фото товара в нужном порядке (до 10)' })
  photos(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PhotosDto) {
    return this.products.updatePhotos(id, dto.fileIds);
  }

  @Put(':id/prices')
  @RequirePermission('prices.write')
  @ApiOperation({ summary: 'Установить цены (тип цены × точка × единица)' })
  setPrices(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPricesDto) {
    return this.products.setPrices(id, dto.items);
  }
}

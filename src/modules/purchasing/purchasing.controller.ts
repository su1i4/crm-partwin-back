import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { AutoOrderService } from './auto-order.service';
import { PriceListsService } from './price-lists.service';
import {
  AutoOrderCreateDto,
  AutoOrderQueryDto,
  ChooseDto,
  CreateFromRowDto,
  ExpectedQuery,
  ExtraCostsDto,
  IssueDto,
  LoadPriceListDto,
  OffersDto,
  OrderReceivingDto,
  OrderStatusDto,
  OrdersQuery,
  PrepayDto,
  PreviewPriceListDto,
  PriceListDto,
  PriceRowsQuery,
  PurchaseOrderDto,
  RefuseDto,
  RequestDto,
  RequestOrderDto,
  RequestsQuery,
  RequestStatusDto,
  StockRulesDto,
  SupplierProductsDto,
  UpdatePriceListDto,
  UpdatePurchaseOrderDto,
  UpdateRequestDto,
  WaitlistDto,
  WaitlistQuery,
  WaitlistStatusDto,
  WarrantyReturnDto,
} from './purchasing.dto';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ReceivingsService } from './receivings.service';
import { RequestsService } from './requests.service';

@ApiTags('Закупки: прайсы поставщиков')
@Controller()
export class PriceListsController {
  constructor(private readonly service: PriceListsService) {}

  @Get('price-lists')
  @RequireAnyPermission('purchasing.pricelists', 'purchasing.orders')
  list(@Query('supplierId') supplierId?: string) {
    return this.service.list(supplierId);
  }

  @Get('price-lists/fields')
  @RequirePermission('purchasing.pricelists')
  fields() {
    return this.service.fields();
  }

  @Get('price-lists/search')
  @RequireAnyPermission('purchasing.pricelists', 'pos.use', 'products.read')
  @ApiOperation({ summary: 'Поиск по всем прайсам: у кого есть, почём, за сколько привезут (с аналогами)' })
  search(@Query('q') q: string) {
    return this.service.search(q ?? '');
  }

  @Post('price-lists')
  @RequirePermission('purchasing.pricelists')
  create(@Body() dto: PriceListDto) {
    return this.service.create({ ...dto, supplierId: dto.supplierId! });
  }

  @Get('price-lists/:id')
  @RequireAnyPermission('purchasing.pricelists', 'purchasing.orders')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Patch('price-lists/:id')
  @RequirePermission('purchasing.pricelists')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceListDto) {
    return this.service.update(id, dto.version, dto as any);
  }

  @Delete('price-lists/:id')
  @HttpCode(204)
  @RequirePermission('purchasing.pricelists')
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.service.remove(id, version);
  }

  @Post('price-lists/:id/preview')
  @RequirePermission('purchasing.pricelists')
  @ApiOperation({ summary: 'Шаг 1: колонки и образец; сопоставление — запомненное или угаданное' })
  preview(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewPriceListDto) {
    return this.service.preview(id, dto.fileId, dto.headerRow);
  }

  @Post('price-lists/:id/load')
  @RequirePermission('purchasing.pricelists')
  @ApiOperation({ summary: 'Шаг 2: загрузить (файл или по ссылке) в фоне; сопоставление запоминается' })
  load(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LoadPriceListDto) {
    return this.service.load(id, dto as any);
  }

  @Get('price-lists/:id/rows')
  @RequireAnyPermission('purchasing.pricelists', 'purchasing.orders')
  rows(@Param('id', ParseUUIDPipe) id: string, @Query() q: PriceRowsQuery) {
    return this.service.rows(id, q);
  }

  @Get('price-list-rows/:id/history')
  @RequireAnyPermission('purchasing.pricelists', 'products.view_cost')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(id);
  }

  @Post('price-list-rows/:id/create-product')
  @RequireAnyPermission('products.write', 'products.quick_create')
  @ApiOperation({ summary: 'Создать товар из строки прайса: номер, бренд, аналоги (OEM), применимость' })
  createProduct(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFromRowDto) {
    return this.service.createProduct(id, dto);
  }
}

@ApiTags('Закупки: заказы и автозаказ')
@Controller()
export class PurchaseOrdersController {
  constructor(
    private readonly orders: PurchaseOrdersService,
    private readonly auto: AutoOrderService,
    private readonly receivings: ReceivingsService,
  ) {}

  @Get('purchase-orders')
  @RequireAnyPermission('purchasing.orders', 'stock.receive')
  list(@Query() q: OrdersQuery) {
    return this.orders.list(q);
  }

  @Get('purchase-orders/expected')
  @RequireAnyPermission('purchasing.orders', 'stock.read')
  @ApiOperation({ summary: 'Сколько ожидается по открытым заказам (в базовых единицах)' })
  expected(@Query() q: ExpectedQuery) {
    return this.orders.expectedList(q.productIds, q.storeId);
  }

  @Post('purchase-orders')
  @RequirePermission('purchasing.orders')
  create(@Body() dto: PurchaseOrderDto) {
    return this.orders.create({ ...dto, supplierId: dto.supplierId! } as any);
  }

  @Get('purchase-orders/:id')
  @RequireAnyPermission('purchasing.orders', 'stock.receive')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }

  @Patch('purchase-orders/:id')
  @RequirePermission('purchasing.orders')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.orders.update(id, dto.version, dto as any);
  }

  @Post('purchase-orders/:id/status')
  @RequirePermission('purchasing.orders')
  @ApiOperation({ summary: 'Отправлен → подтверждён → … → закрыт / отменён' })
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderStatusDto) {
    return this.orders.setStatus(id, dto.version, dto.status, dto.note);
  }

  @Post('purchase-orders/:id/receiving')
  @RequirePermission('stock.receive')
  @ApiOperation({ summary: 'Черновик приёмки по заказу (остаток строк, сверка «ожидалось / пришло»)' })
  receiving(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderReceivingDto) {
    return this.orders.createReceiving(id, dto);
  }

  @Get('purchase-orders/:id/message')
  @RequirePermission('purchasing.orders')
  @ApiOperation({ summary: 'Текст заказа и ссылки WhatsApp / Telegram' })
  message(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.message(id);
  }

  @Get('purchase-orders/:id/pdf')
  @RequirePermission('purchasing.orders')
  @Header('Content-Type', 'application/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', 'inline; filename="order.pdf"');
    return new StreamableFile(await this.orders.pdfFile(id));
  }

  @Get('purchase-orders/:id/xlsx')
  @RequirePermission('purchasing.orders')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async xlsx(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', 'attachment; filename="order.xlsx"');
    return new StreamableFile(await this.orders.excelFile(id));
  }

  @Post('auto-order/preview')
  @RequirePermission('purchasing.orders')
  @ApiOperation({ summary: 'Автозаказ: что заказать (мин./макс., сезонность, продажи, срок, кратность, ожидаемое)' })
  autoPreview(@Body() dto: AutoOrderQueryDto) {
    return this.auto.preview(dto);
  }

  @Post('auto-order/create')
  @RequirePermission('purchasing.orders')
  @ApiOperation({ summary: 'Черновики заказов по поставщикам из строк автозаказа' })
  autoCreate(@Body() dto: AutoOrderCreateDto) {
    return this.auto.create(dto as any);
  }

  @Get('products/:id/suppliers')
  @RequireAnyPermission('purchasing.orders', 'purchasing.suppliers', 'products.write')
  suppliers(@Param('id', ParseUUIDPipe) id: string) {
    return this.auto.supplierProducts(id);
  }

  @Put('products/:id/suppliers')
  @RequireAnyPermission('purchasing.orders', 'purchasing.suppliers')
  @ApiOperation({ summary: 'Поставщики товара: код поставщика (ищется в поиске), кратность, мин. партия, срок, основной' })
  setSuppliers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierProductsDto) {
    return this.auto.setSupplierProducts(id, dto.items);
  }

  @Get('products/:id/stock-rules')
  @RequireAnyPermission('purchasing.orders', 'stock.read')
  stockRules(@Param('id', ParseUUIDPipe) id: string) {
    return this.auto.stockRules(id);
  }

  @Put('products/:id/stock-rules')
  @RequirePermission('purchasing.orders')
  @ApiOperation({ summary: 'Мин./макс. остаток (и сезонные лето / зима) по точкам' })
  setStockRules(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StockRulesDto) {
    return this.auto.setStockRules(id, dto.rules);
  }

  @Get('products/:id/purchase-history')
  @RequirePermission('products.view_cost')
  purchaseHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.auto.purchaseHistory(id);
  }

  @Post('receivings/:id/extra-costs')
  @RequirePermission('stock.receive')
  @ApiOperation({ summary: 'Доп. расходы к приёмке позже: по сумме, количеству, весу, объёму или вручную; себестоимость пересчитается' })
  extraCosts(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtraCostsDto) {
    return this.receivings.extraCosts(id, dto);
  }

  @Post('warranty/:id/supplier-return')
  @RequireAnyPermission('sales.warranty', 'stock.receive')
  @ApiOperation({ summary: 'Гарантийный возврат поставщику из обращения' })
  warrantyReturn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WarrantyReturnDto) {
    return this.receivings.warrantyReturn(id, dto);
  }
}

@ApiTags('Заявки клиентов и лист ожидания')
@Controller()
export class RequestsController {
  constructor(private readonly service: RequestsService) {}

  @Get('requests')
  @RequirePermission('requests.read')
  @ApiOperation({ summary: 'Заявки: список или канбан (view=kanban); просроченные — первыми' })
  list(@Query() q: RequestsQuery) {
    return this.service.list(q);
  }

  @Post('requests')
  @RequirePermission('requests.write')
  @ApiOperation({ summary: 'Новая заявка: что нужно (номер, название, фото), клиент, машина' })
  create(@Body() dto: RequestDto) {
    return this.service.create({ ...dto, items: dto.items ?? [] });
  }

  @Get('requests/:id')
  @RequirePermission('requests.read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Patch('requests/:id')
  @RequirePermission('requests.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRequestDto) {
    return this.service.update(id, dto.version, dto);
  }

  @Get('requests/:id/suggest')
  @RequirePermission('requests.write')
  @ApiOperation({ summary: 'Найденные варианты: каталог (наличие) и прайсы поставщиков' })
  suggest(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.suggest(id);
  }

  @Post('requests/:id/offer')
  @RequirePermission('requests.write')
  @ApiOperation({ summary: 'Предложение клиенту: варианты с ценами («лестница» по классам)' })
  offer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OffersDto) {
    return this.service.offer(id, dto.version, dto);
  }

  @Post('requests/:id/choose')
  @RequirePermission('requests.write')
  choose(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChooseDto) {
    return this.service.choose(id, dto.version, dto);
  }

  @Post('requests/:id/order')
  @RequirePermission('requests.write')
  @ApiOperation({ summary: 'У кого заказали: поставщик (строка в черновик заказа) или сосед' })
  order(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestOrderDto) {
    return this.service.order(id, dto.version, dto);
  }

  @Post('requests/:id/status')
  @RequirePermission('requests.write')
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestStatusDto) {
    return this.service.setStatus(id, dto.version, dto.status, dto.note);
  }

  @Post('requests/:id/prepay')
  @RequireAnyPermission('requests.write', 'pos.use')
  @ApiOperation({ summary: 'Предоплата: засчитывается при выдаче' })
  prepay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PrepayDto) {
    return this.service.prepay(id, dto.version, dto);
  }

  @Post('requests/:id/issue')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Выдать: приёмка (если нужна) или «взял у соседа», продажа, предоплата засчитана' })
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueDto) {
    return this.service.issue(id, dto.version, dto);
  }

  @Post('requests/:id/refuse')
  @RequirePermission('requests.write')
  @ApiOperation({ summary: 'Отказ: предоплата — деньгами или в аванс; заявка — в «Что спрашивают, но нет»' })
  refuse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RefuseDto) {
    return this.service.refuse(id, dto.version, dto);
  }

  @Get('requests/:id/message')
  @RequirePermission('requests.read')
  @ApiOperation({ summary: '«Ваша деталь пришла» — текст и ссылка WhatsApp' })
  message(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.message(id);
  }

  @Get('waitlist')
  @RequireAnyPermission('requests.read', 'pos.use')
  waitlist(@Query() q: WaitlistQuery) {
    return this.service.waitlist(q);
  }

  @Post('waitlist')
  @RequireAnyPermission('requests.write', 'pos.use')
  @ApiOperation({ summary: 'Клиент ждёт товар — уведомим, когда придёт' })
  addWaitlist(@Body() dto: WaitlistDto) {
    return this.service.addWaitlist(dto);
  }

  @Post('waitlist/:id/status')
  @RequireAnyPermission('requests.write', 'pos.use')
  waitlistStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WaitlistStatusDto) {
    return this.service.setWaitlistStatus(id, dto.version, dto.status);
  }
}

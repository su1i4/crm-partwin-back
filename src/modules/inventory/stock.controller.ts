import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { Errors } from '../../common/errors/app.exception';
import { LabelsService } from '../printing/labels.service';
import {
  AtDateQueryDto,
  ClosePeriodDto,
  CountDto,
  CreateInventoryDto,
  EnableStockControlDto,
  FinishInventoryDto,
  MovementsQueryDto,
  ProductLabelsDto,
  ReopenPeriodDto,
  SetPlaceDto,
  SheetDto,
  StockQueryDto,
  TurnoverQueryDto,
} from './dto/stock.dto';
import { InventoryCountService } from './inventory-count.service';
import { PeriodCloseService } from './period-close.service';
import { PlacesService } from './places.service';
import { StockControlService } from './stock-control.service';
import { StockMaintenanceService } from './stock-maintenance.service';
import { StockQueryService } from './stock-query.service';

@ApiTags('Склад: остатки')
@Controller()
export class StockController {
  constructor(
    private readonly query: StockQueryService,
    private readonly places: PlacesService,
    private readonly maintenance: StockMaintenanceService,
    private readonly control: StockControlService,
    private readonly labels: LabelsService,
  ) {}

  @Get('stock')
  @RequirePermission('stock.read')
  @ApiOperation({ summary: 'Остатки: по складам, место, в пути, доступно; сумма — при праве видеть себестоимость' })
  balances(@Query() q: StockQueryDto) {
    return this.query.balances(q);
  }

  @Get('stock/at-date')
  @RequirePermission('stock.read')
  @ApiOperation({ summary: 'Остатки на дату' })
  atDate(@Query() q: AtDateQueryDto) {
    return this.query.atDate(q);
  }

  @Get('stock/turnover')
  @RequireAnyPermission('reports.stock', 'stock.read')
  @ApiOperation({ summary: 'Оборотная ведомость' })
  turnover(@Query() q: TurnoverQueryDto) {
    return this.query.turnover(q);
  }

  @Get('stock/places/suggest')
  @RequirePermission('stock.read')
  @ApiQuery({ name: 'warehouseId' })
  @ApiQuery({ name: 'q', required: false })
  suggest(@Query('warehouseId', ParseUUIDPipe) warehouseId: string, @Query('q') q?: string) {
    return this.places.suggest(warehouseId, q);
  }

  @Put('stock/places')
  @RequireAnyPermission('stock.locations', 'products.write')
  @ApiOperation({ summary: 'Место хранения (уровень 1) для товаров на складе, массово' })
  setPlace(@Body() dto: SetPlaceDto) {
    return this.places.set(dto.warehouseId, dto.productIds, dto.place ?? null);
  }

  @Get('stock/reconcile')
  @RequirePermission('stock.read')
  @ApiOperation({ summary: 'Сверка кэша остатков с движениями' })
  reconcile() {
    return this.maintenance.reconcile(undefined);
  }

  @Post('stock/rebuild')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: '«Пересчитать остатки» из движений' })
  rebuild() {
    return this.maintenance.rebuild();
  }

  @Get('products/:id/movements')
  @RequirePermission('stock.read')
  @ApiOperation({ summary: 'Движения товара с нарастающим остатком' })
  movements(@Param('id', ParseUUIDPipe) id: string, @Query() q: MovementsQueryDto) {
    return this.query.productMovements(id, q);
  }

  @Get('products/:id/serials')
  @RequirePermission('stock.read')
  @ApiQuery({ name: 'status', required: false })
  @ApiOperation({ summary: 'Серийные экземпляры товара' })
  serials(@Param('id', ParseUUIDPipe) id: string, @Query('status') status?: string) {
    return this.query.serials(id, status);
  }

  @Post('products/:id/stock-control')
  @HttpCode(200)
  @RequirePermission('stock.receive')
  @ApiOperation({ summary: 'Включить учёт остатка: ввод фактического остатка по складам' })
  enableStock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EnableStockControlDto) {
    return this.control.enable(id, dto.items);
  }

  @Post('products/labels.pdf')
  @HttpCode(200)
  @RequirePermission('stock.labels')
  @ApiOperation({ summary: 'Этикетки на выбранные товары (PDF)' })
  async productLabels(@Body() dto: ProductLabelsDto, @Res({ passthrough: true }) res: Response) {
    for (const i of dto.items) if (!i?.productId || !(Number(i.copies) > 0)) throw Errors.bad('BAD_ITEMS', 'items: { productId, copies > 0 }');
    const pdf = await this.labels.render(
      dto.items.map((i) => ({ ...i, copies: Math.floor(Number(i.copies)) })),
      { w: dto.w ?? 58, h: dto.h ?? 40 },
    );
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="labels.pdf"' });
    return new StreamableFile(pdf);
  }
}

@ApiTags('Склад: инвентаризация')
@Controller('inventories')
export class InventoriesController {
  constructor(private readonly inv: InventoryCountService) {}

  @Post()
  @RequirePermission('stock.inventory')
  @ApiOperation({ summary: 'Начать инвентаризацию (полную или частичную: категория, бренд, полка, список)' })
  create(@Body() dto: CreateInventoryDto) {
    const { warehouseId, comment, sheetName, ...scope } = dto;
    return this.inv.create({ warehouseId, comment, sheetName, scope });
  }

  @Get(':id')
  @RequirePermission('stock.inventory')
  @ApiOperation({ summary: 'Сверка: учётное на время скана, посчитано, расхождение; поздние движения' })
  view(@Param('id', ParseUUIDPipe) id: string) {
    return this.inv.view(id);
  }

  @Post(':id/sheets')
  @RequirePermission('stock.inventory')
  @ApiOperation({ summary: 'Ещё один лист подсчёта (параллельно, суммируются)' })
  sheet(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SheetDto) {
    return this.inv.addSheet(id, dto.name, dto.assignedTo);
  }

  @Post(':id/counts')
  @RequirePermission('stock.inventory')
  @ApiOperation({ summary: 'Скан / ввод количества (mode=add — прибавить, set — заменить в листе)' })
  count(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CountDto) {
    return this.inv.count(id, dto);
  }

  @Post(':id/finish')
  @HttpCode(200)
  @RequireAnyPermission('documents.post')
  @ApiOperation({ summary: 'Завершить: оприходование излишков и списание недостачи' })
  finish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FinishInventoryDto) {
    return this.inv.finish(id, dto.version, dto.uncountedAsZero ?? true);
  }
}

@ApiTags('Закрытие периода')
@Controller('periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodCloseService) {}

  @Get()
  @RequireAnyPermission('period.close', 'settings.manage')
  @ApiOperation({ summary: 'Закрытые периоды и следующий к закрытию' })
  list() {
    return this.periods.list();
  }

  @Post('close')
  @HttpCode(200)
  @RequirePermission('period.close')
  @ApiOperation({ summary: 'Закрыть месяц: снимок остатков и себестоимости, документы месяца — только чтение' })
  close(@Body() dto: ClosePeriodDto) {
    return this.periods.close(dto.month);
  }

  @Post('reopen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Открыть последний закрытый месяц (только владелец, с причиной)' })
  reopen(@Body() dto: ReopenPeriodDto) {
    return this.periods.reopen(dto.month, dto.reason);
  }
}

import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Length, Min, ValidateNested } from 'class-validator';
import { RequestContext } from '../../common/context/request-context';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { WholesaleService } from './wholesale.service';

class QtyLine {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsNumberString() qty: string;
}
class PricedLine extends QtyLine {
  @ApiPropertyOptional() @IsOptional() @IsNumberString() price?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}
class LineQty {
  @ApiProperty() @IsUUID() lineId: string;
  @ApiProperty() @IsNumberString() qty: string;
  @ApiPropertyOptional({ description: 'Бой / пересорт' }) @IsOptional() @IsNumberString() damaged?: string;
}
export class ContainerDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiPropertyOptional({ enum: ['USD', 'CNY', 'AED', 'KGS', 'EUR', 'RUB'] }) @IsOptional() @IsIn(['USD', 'CNY', 'AED', 'KGS', 'EUR', 'RUB']) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() rate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedOn?: string;
  @ApiPropertyOptional({ enum: ['volume', 'weight', 'amount', 'manual'] }) @IsOptional() @IsIn(['volume', 'weight', 'amount', 'manual']) distribution?: 'volume' | 'weight' | 'amount' | 'manual';
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}
export class ContainerUpdateDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() rate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expectedOn?: string;
  @ApiPropertyOptional({ enum: ['volume', 'weight', 'amount', 'manual'] }) @IsOptional() @IsIn(['volume', 'weight', 'amount', 'manual']) distribution?: any;
  @ApiPropertyOptional({ example: [{ name: 'Карго', amount: '120000', currency: 'KGS' }] }) @IsOptional() @IsArray() costs?: { name: string; amount: string; currency: string }[];
  @ApiPropertyOptional({ description: 'Ручное распределение: [{ lineId, amount }] в сомах' }) @IsOptional() @IsArray() manualCosts?: { lineId: string; amount: string }[];
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}
export class InvoiceImportDto {
  @ApiProperty() @IsUUID() fileId: string;
  @ApiProperty({ example: { code: 1, name: 2, qty: 3, price: 4, volume: 5, weight: 6 }, description: 'Номера колонок с 1' }) @IsObject() columns: { code?: number; name?: number; qty: number; price: number; volume?: number; weight?: number };
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(0) skipRows?: number;
}
export class MatchDto {
  @ApiProperty() @IsUUID() productId: string;
}
export class CreateProductsDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
}
export class PrepayDto {
  @ApiProperty() @IsUUID() accountId: string;
  @ApiProperty() @IsNumberString() amount: string;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}
export class StatusDto {
  @ApiProperty({ enum: ['paid', 'in_transit', 'customs'] }) @IsIn(['paid', 'in_transit', 'customs']) status: any;
}
export class ReceiveDto {
  @ApiPropertyOptional({ type: [LineQty], description: 'Пусто — всё, что осталось' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LineQty) lines?: LineQty[];
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() post?: boolean;
}
export class OrderDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiProperty({ type: [PricedLine] }) @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PricedLine) lines: PricedLine[];
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() reserve?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) address?: string;
  @ApiPropertyOptional({ description: 'Водитель (участник)' }) @IsOptional() @IsUUID() driverId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() deliveryCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() comment?: string;
}
export class LinePriceDto {
  @ApiProperty() @IsNumberString() price: string;
}
export class ShipDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiPropertyOptional({ type: [LineQty], description: 'Пусто — всё оставшееся' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LineQty) lines?: LineQty[];
  @ApiPropertyOptional({ description: 'Оплаты; пусто — предоплата, остальное в долг' }) @IsOptional() @IsArray() payments?: any[];
  @ApiPropertyOptional() @IsOptional() @IsIn(['KGS', 'USD']) changeCurrency?: 'KGS' | 'USD';
  @ApiPropertyOptional() @IsOptional() @IsString() pin?: string;
}
export class CancelOrderDto {
  @ApiProperty({ enum: ['advance', 'refund'], description: 'Предоплата: оставить авансом или вернуть' }) @IsIn(['advance', 'refund']) prepayment: 'advance' | 'refund';
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}
export class DeliveryDto {
  @ApiProperty({ enum: ['assembled', 'on_way', 'delivered', 'paid', 'returned'] }) @IsIn(['assembled', 'on_way', 'delivered', 'paid', 'returned']) status: any;
  @ApiPropertyOptional({ example: { method: 'cash', amount: '15000' } }) @IsOptional() @IsObject() payment?: { method: 'cash' | 'transfer'; amount: string; accountId?: string };
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}
export class HandoverDto {
  @ApiPropertyOptional({ description: 'Водитель (по умолчанию — я)' }) @IsOptional() @IsUUID() driverId?: string;
  @ApiProperty({ description: 'Касса / сейф' }) @IsUUID() toAccountId: string;
  @ApiPropertyOptional({ description: 'Пусто — всё' }) @IsOptional() @IsNumberString() amount?: string;
}
export class ConsignDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ type: [QtyLine] }) @IsArray() @ValidateNested({ each: true }) @Type(() => QtyLine) lines: QtyLine[];
}
export class ConsignReportDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiProperty() @IsUUID() registerId: string;
  @ApiProperty({ type: [PricedLine] }) @IsArray() @ValidateNested({ each: true }) @Type(() => PricedLine) sold: PricedLine[];
}
export class DonorDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ example: 'Toyota Camry 40 2008, 2AZ, АКПП' }) @IsString() @Length(1, 200) title: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() generationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() year?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() vin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyCode?: string;
  @ApiPropertyOptional({ description: 'В т.ч. «двигатель другой»' }) @IsOptional() @IsString() engine?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() transmission?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() purchasePrice?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() deliveryCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() customsCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() otherCost?: string;
  @ApiPropertyOptional({ description: 'Ожидаемая выручка со всех деталей' }) @IsOptional() @IsNumberString() expectedTotal?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
}
class DonorLine extends QtyLine {
  @ApiPropertyOptional({ description: 'Ожидаемая цена продажи' }) @IsOptional() @IsNumberString() expectedPrice?: string;
  @ApiPropertyOptional({ description: 'Себестоимость вручную' }) @IsOptional() @IsNumberString() cost?: string;
}
export class DonorPartsDto {
  @ApiProperty({ type: [DonorLine] }) @IsArray() @ValidateNested({ each: true }) @Type(() => DonorLine) lines: DonorLine[];
  @ApiPropertyOptional({ description: 'Последняя партия: забрать весь нераспределённый остаток' }) @IsOptional() @IsBoolean() close?: boolean;
}

@ApiTags('Опт: контейнеры, заказы, доставка, реализация, доноры')
@Controller()
export class WholesaleController {
  constructor(
    private readonly w: WholesaleService,
    private readonly ctx: RequestContext,
  ) {}

  @Get('containers') @RequirePermission('purchasing.containers') containers(@Query('status') status?: string) {
    return this.w.listContainers(status);
  }
  @Post('containers') @RequirePermission('purchasing.containers') createContainer(@Body() dto: ContainerDto) {
    return this.w.createContainer(dto);
  }
  @Get('containers/:id') @RequirePermission('purchasing.containers') container(@Param('id', ParseUUIDPipe) id: string) {
    return this.w.getContainer(id);
  }
  @Patch('containers/:id') @RequirePermission('purchasing.containers') updateContainer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ContainerUpdateDto) {
    const { version, ...rest } = dto;
    return this.w.updateContainer(id, version, rest as any);
  }
  @Post('containers/:id/invoice') @RequirePermission('purchasing.containers') @ApiOperation({ summary: 'Импорт инвойса: строки сопоставляются по запомненному и по номеру' })
  invoice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceImportDto) {
    return this.w.importInvoice(id, dto);
  }
  @Post('containers/:id/lines/:lineId/match') @RequirePermission('purchasing.containers') match(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: MatchDto) {
    return this.w.matchLine(id, lineId, dto.productId);
  }
  @Post('containers/:id/create-products') @RequirePermission('products.write') @ApiOperation({ summary: 'Несопоставленные строки → новые товары' })
  createProducts(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateProductsDto) {
    return this.w.createProductsForUnmatched(id, dto);
  }
  @Post('containers/:id/prepay') @RequirePermission('money.write') prepay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PrepayDto) {
    return this.w.prepay(id, dto);
  }
  @Post('containers/:id/status') @RequirePermission('purchasing.containers') status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    return this.w.setContainerStatus(id, dto.status);
  }
  @Post('containers/:id/receive') @RequirePermission('stock.receive') @ApiOperation({ summary: 'Приёмка контейнера (частями), расходы — в себестоимость' })
  receive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveDto) {
    return this.w.receiveContainer(id, dto);
  }
  @Get('containers-expected') @RequirePermission('stock.read') @ApiOperation({ summary: 'Товар «ожидается» из контейнеров в пути' })
  expected(@Query('productIds') ids?: string) {
    return this.w.expected(ids ? ids.split(',') : undefined);
  }

  @Get('sales-orders') @RequireAnyPermission('sales.orders', 'deliveries.own') orders(@Query('status') status?: string, @Query('counterpartyId') counterpartyId?: string, @Query('mine') mine?: string) {
    return this.w.listOrders({ status, counterpartyId, driver: mine === 'true' || !this.ctx.can('sales.orders') });
  }
  @Post('sales-orders') @RequirePermission('sales.orders') @ApiOperation({ summary: 'Заказ покупателя: цены фиксируются, резерв' })
  createOrder(@Body() dto: OrderDto) {
    return this.w.createOrder(dto);
  }
  @Get('sales-orders/:id') @RequireAnyPermission('sales.orders', 'deliveries.own') order(@Param('id', ParseUUIDPipe) id: string) {
    return this.w.getOrder(id);
  }
  @Patch('sales-orders/:id/lines/:lineId') @RequirePermission('sales.custom_price') price(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() dto: LinePriceDto) {
    return this.w.setOrderPrice(id, lineId, dto.price);
  }
  @Post('sales-orders/:id/prepay') @RequirePermission('sales.orders') prepayOrder(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PrepayDto) {
    return this.w.prepayOrder(id, dto);
  }
  @Post('sales-orders/:id/ship') @RequirePermission('sales.orders') @ApiOperation({ summary: 'Отгрузка (полная или частичная)' })
  ship(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ShipDto) {
    return this.w.ship(id, dto);
  }
  @Post('sales-orders/:id/cancel') @RequirePermission('sales.orders') cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOrderDto) {
    return this.w.cancelOrder(id, dto);
  }
  @Post('sales-orders/:id/delivery') @RequireAnyPermission('deliveries.own', 'deliveries.manage') @ApiOperation({ summary: 'Водитель: собран → в пути → доставлен → оплачен' })
  delivery(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryDto) {
    return this.w.deliveryStatus(id, dto);
  }
  @Post('deliveries/handover') @RequireAnyPermission('deliveries.own', 'deliveries.manage') @ApiOperation({ summary: 'Водитель сдал выручку: подотчёт → касса' })
  handover(@Body() dto: HandoverDto) {
    return this.w.driverHandover(dto);
  }

  @Get('consignments') @RequirePermission('sales.orders') @ApiOperation({ summary: 'Реализаторы: остатки и долги' })
  consignees() {
    return this.w.consignees();
  }
  @Post('consignments') @RequirePermission('sales.orders') consign(@Body() dto: ConsignDto) {
    return this.w.consign(dto);
  }
  @Post('consignments/report') @RequirePermission('sales.orders') @ApiOperation({ summary: 'Отчёт реализатора: проданное → долг' })
  report(@Body() dto: ConsignReportDto) {
    return this.w.consignmentReport(dto);
  }
  @Post('consignments/return') @RequirePermission('sales.orders') ret(@Body() dto: ConsignDto) {
    return this.w.consignmentReturn(dto);
  }

  @Get('donors') @RequirePermission('stock.receive') donors() {
    return this.w.listDonors();
  }
  @Post('donors') @RequirePermission('stock.receive') donor(@Body() dto: DonorDto) {
    return this.w.createDonor(dto as any);
  }
  @Get('donors/:id') @RequirePermission('stock.receive') @ApiOperation({ summary: 'Донор: вложено, распределено, продано, осталось' })
  getDonor(@Param('id', ParseUUIDPipe) id: string) {
    return this.w.getDonor(id);
  }
  @Post('donors/:id/parts') @RequirePermission('stock.receive') @ApiOperation({ summary: 'Приход деталей с донора частями' })
  parts(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DonorPartsDto) {
    return this.w.donorParts(id, dto);
  }
}

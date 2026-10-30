import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import { Response } from 'express';
import { Public, RequirePermission } from '../../common/decorators/auth.decorators';
import { StoService } from './sto.service';

class QtyLineDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ example: '1' }) @IsNumberString() qty: string;
}
class PricedLineDto extends QtyLineDto {
  @ApiProperty({ example: '500' }) @IsNumberString() price: string;
}
export class SelectionDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerVehicleId?: string;
  @ApiPropertyOptional({ description: 'Склад, откуда выдаём (по умолчанию — торговый зал точки)' }) @IsOptional() @IsUUID() warehouseId?: string;
  @ApiProperty({ type: [QtyLineDto] }) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => QtyLineDto) lines: QtyLineDto[];
  @ApiPropertyOptional({ example: 3 }) @IsOptional() @IsInt() @Min(1) @Max(60) days?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}
export class CloseSelectionDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiProperty({ type: [QtyLineDto], description: 'Что подошло — продаётся; остальное возвращается на склад' }) @IsArray() @ValidateNested({ each: true }) @Type(() => QtyLineDto) fitted: QtyLineDto[];
  @ApiPropertyOptional({ description: 'Оплаты, как в чеке (в т.ч. { method: "debt" })' }) @IsOptional() @IsArray() payments?: any[];
  @ApiPropertyOptional() @IsOptional() @IsIn(['KGS', 'USD']) changeCurrency?: 'KGS' | 'USD';
  @ApiPropertyOptional() @IsOptional() @IsString() pin?: string;
}
export class RuleDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
  @ApiPropertyOptional({ description: 'Пусто — для всех мастеров' }) @IsOptional() @IsUUID() masterId?: string | null;
  @ApiPropertyOptional({ description: 'Пусто — на все группы' }) @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional({ enum: ['percent_sales', 'percent_margin', 'fixed'] }) @IsOptional() @IsIn(['percent_sales', 'percent_margin', 'fixed']) kind?: 'percent_sales' | 'percent_margin' | 'fixed';
  @ApiPropertyOptional({ example: '5' }) @IsOptional() @IsNumberString() value?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class PersonalPriceDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ example: '1450', nullable: true, description: 'null — убрать персональную цену' }) @IsOptional() @IsString() price: string | null;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
}
export class PriceListQuery {
  @ApiPropertyOptional({ enum: ['xlsx', 'pdf'] }) @IsOptional() @IsIn(['xlsx', 'pdf']) format?: 'xlsx' | 'pdf';
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() inStockOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
}
export class SubscribeDto {
  @ApiProperty() @IsBoolean() subscribed: boolean;
}
export class CustomerPurchaseDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional({ example: 'Бакыт' }) @IsOptional() @IsString() @Length(1, 100) sellerName?: string;
  @ApiPropertyOptional({ example: '0555123456' }) @IsOptional() @IsString() @Length(5, 20) sellerPhone?: string;
  @ApiProperty({ description: 'Откуда платим: касса или кошелёк' }) @IsUUID() accountId: string;
  @ApiProperty({ type: [PricedLineDto] }) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => PricedLineDto) lines: PricedLineDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}
export class TaskDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dueAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() remindAt?: string;
  @ApiPropertyOptional({ enum: ['open', 'done', 'cancelled'] }) @IsOptional() @IsIn(['open', 'done', 'cancelled']) status?: 'open' | 'done' | 'cancelled';
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerVehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
}
export class OilRuleDto {
  @ApiPropertyOptional({ description: 'Группа «Масла» (пусто — любая покупка)' }) @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ example: 6 }) @IsOptional() @IsInt() @Min(1) @Max(36) months?: number;
}
export class TemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 2000) textRu?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) textKy?: string;
}
export class MessageDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiProperty({ example: 'debt_reminder' }) @IsString() code: string;
  @ApiPropertyOptional({ example: { сумма: '5000' } }) @IsOptional() @IsObject() vars?: Record<string, string>;
  @ApiPropertyOptional({ enum: ['ru', 'ky'] }) @IsOptional() @IsIn(['ru', 'ky']) lang?: 'ru' | 'ky';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sendTelegram?: boolean;
}
export class ActivityDto {
  @ApiProperty({ enum: ['call', 'note'] }) @IsIn(['call', 'note']) kind: 'call' | 'note';
  @ApiProperty() @IsString() @Length(1, 2000) text: string;
}

@ApiTags('СТО, мастера, клиенты, задачи')
@Controller()
export class StoController {
  constructor(private readonly sto: StoService) {}

  @Get('selections')
  @RequirePermission('sales.selection')
  @ApiOperation({ summary: 'Выдачи на подбор (просроченные помечены)' })
  selections(@Query('status') status?: string, @Query('counterpartyId') counterpartyId?: string) {
    return this.sto.listSelections({ status, counterpartyId });
  }

  @Post('selections')
  @RequirePermission('sales.selection')
  @ApiOperation({ summary: 'Выдать на подбор: товар — на склад «У клиента», срок' })
  issue(@Body() dto: SelectionDto) {
    return this.sto.issueSelection(dto);
  }

  @Post('selections/:id/close')
  @RequirePermission('sales.selection')
  @ApiOperation({ summary: 'Закрыть: подошедшее — продажа (с оплатой или в долг), остальное — назад на склад' })
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseSelectionDto) {
    return this.sto.closeSelection(id, dto);
  }

  @Get('master-bonuses/rules')
  @RequirePermission('customers.bonuses')
  rules() {
    return this.sto.rules();
  }

  @Post('master-bonuses/rules')
  @RequirePermission('customers.bonuses')
  addRule(@Body() dto: RuleDto) {
    return this.sto.saveRule(null, dto as any);
  }

  @Patch('master-bonuses/rules/:id')
  @RequirePermission('customers.bonuses')
  updateRule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RuleDto) {
    return this.sto.saveRule(id, dto as any);
  }

  @Get('master-bonuses')
  @RequirePermission('customers.bonuses')
  @ApiOperation({ summary: 'Бонусы мастерам за период: начислено, выплачено, должны. Выплата — /debts/payments (out) или зачёт' })
  bonuses(@Query('from') from?: string, @Query('to') to?: string, @Query('masterId') masterId?: string) {
    return this.sto.masterBonuses({ from, to, masterId });
  }

  @Get('counterparties/:id/personal-prices')
  @RequirePermission('prices.read')
  personal(@Param('id', ParseUUIDPipe) id: string) {
    return this.sto.personalPrices(id);
  }

  @Put('counterparties/:id/personal-prices')
  @RequirePermission('prices.write')
  setPersonal(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PersonalPriceDto) {
    return this.sto.setPersonalPrice(id, dto);
  }

  @Get('counterparties/:id/price-list')
  @RequirePermission('prices.read')
  @ApiOperation({ summary: 'Прайс-лист клиенту по типу цены его группы: Excel или PDF' })
  async priceList(@Param('id', ParseUUIDPipe) id: string, @Query() q: PriceListQuery, @Res({ passthrough: true }) res: Response) {
    const f = await this.sto.priceListFile(id, q.format ?? 'xlsx', q);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.name}"` });
    return new StreamableFile(f.buffer);
  }

  @Get('counterparties/:id/price-list/link')
  @RequirePermission('prices.read')
  @ApiOperation({ summary: 'Ссылка на страницу прайса (для WhatsApp / Telegram)' })
  priceLink(@Param('id', ParseUUIDPipe) id: string) {
    return this.sto.priceLink(id);
  }

  @Post('counterparties/:id/price-list/subscribe')
  @RequirePermission('prices.read')
  @ApiOperation({ summary: 'Присылать прайс по понедельникам в Telegram (клиент подключён к боту)' })
  subscribe(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubscribeDto) {
    return this.sto.subscribePriceList(id, dto.subscribed);
  }

  @Public()
  @Get('public/price-list/:tenantId/:counterpartyId/:token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  publicPriceList(@Param('tenantId', ParseUUIDPipe) t: string, @Param('counterpartyId', ParseUUIDPipe) c: string, @Param('token') token: string) {
    return this.sto.publicPriceList(t, c, token);
  }

  @Post('customer-purchases')
  @RequirePermission('purchasing.buy_from_customer')
  @ApiOperation({ summary: 'Покупка у клиента: приход по цене покупки + выплата из кассы или кошелька' })
  purchase(@Body() dto: CustomerPurchaseDto) {
    return this.sto.customerPurchase(dto);
  }

  @Get('tasks')
  tasks(@Query('status') status?: string, @Query('mine') mine?: string, @Query('counterpartyId') counterpartyId?: string) {
    return this.sto.tasks({ status, mine: mine === 'true', counterpartyId });
  }

  @Post('tasks')
  addTask(@Body() dto: TaskDto) {
    return this.sto.saveTask(null, dto as any);
  }

  @Patch('tasks/:id')
  updateTask(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TaskDto) {
    return this.sto.saveTask(id, dto as any);
  }

  @Get('tasks/oil-rules')
  @RequirePermission('customers.write')
  oilRules() {
    return this.sto.oilRules();
  }

  @Post('tasks/oil-rules')
  @RequirePermission('customers.write')
  @ApiOperation({ summary: 'Автонапоминание «замена масла»: через N месяцев после покупки товаров группы' })
  addOilRule(@Body() dto: OilRuleDto) {
    return this.sto.addOilRule(dto);
  }

  @Get('message-templates')
  @RequirePermission('customers.read')
  templates() {
    return this.sto.templates();
  }

  @Put('message-templates/:code')
  @RequirePermission('customers.write')
  saveTemplate(@Param('code') code: string, @Body() dto: TemplateDto) {
    return this.sto.saveTemplate(code, dto);
  }

  @Post('messages')
  @RequirePermission('customers.read')
  @ApiOperation({ summary: 'Текст по шаблону + ссылка WhatsApp; по желанию — в Telegram клиента' })
  message(@Body() dto: MessageDto) {
    return this.sto.message(dto);
  }

  @Get('counterparties/:id/feed')
  @RequirePermission('customers.read')
  feed(@Param('id', ParseUUIDPipe) id: string) {
    return this.sto.feed(id);
  }

  @Post('counterparties/:id/activities')
  @RequirePermission('customers.write')
  activity(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActivityDto) {
    return this.sto.addActivity(id, dto);
  }
}

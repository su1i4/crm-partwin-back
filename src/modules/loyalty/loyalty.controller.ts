import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { RequestContext } from '../../common/context/request-context';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CustomerBotService } from './customer-bot.service';
import { LoyaltyService } from './loyalty.service';

export class PromotionDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
  @ApiPropertyOptional({ example: 'Зима: −10% на аккумуляторы' }) @IsOptional() @IsString() @Length(1, 150) name?: string;
  @ApiPropertyOptional({ enum: ['percent', 'receipt_amount', 'second_item'] }) @IsOptional() @IsIn(['percent', 'receipt_amount', 'second_item']) kind?: 'percent' | 'receipt_amount' | 'second_item';
  @ApiPropertyOptional({ example: '10' }) @IsOptional() @IsNumberString() percent?: string;
  @ApiPropertyOptional({ description: 'Скидка от суммы чека: от скольки' }) @IsOptional() @IsNumberString() minAmount?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) categoryIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) brandIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) qualityClasses?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) makeIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) productIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) storeIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsOn?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() stackable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() byCode?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CodesDto {
  @ApiPropertyOptional({ example: ['ZIMA10'] }) @IsOptional() @IsArray() @IsString({ each: true }) codes?: string[];
  @ApiPropertyOptional({ example: 100, description: 'Сгенерировать N одноразовых кодов' }) @IsOptional() @IsInt() @Min(1) @Max(1000) generate?: number;
  @ApiPropertyOptional({ description: 'Лимит использований (пусто — без лимита)' }) @IsOptional() @IsInt() @Min(1) maxUses?: number;
}

export class CardDto {
  @ApiPropertyOptional({ description: 'Номер готовой пластиковой карты (иначе — сгенерируется)' }) @IsOptional() @IsString() @Length(4, 20) number?: string;
}

export class AdjustDto {
  @ApiProperty({ example: '500' }) @IsNumberString() amount: string;
  @ApiProperty({ example: 'Подарок на день рождения' }) @IsString() @Length(1, 300) comment: string;
}

@ApiTags('Лояльность: акции, промокоды, карты, бонусы')
@Controller('loyalty')
export class LoyaltyController {
  constructor(
    private readonly loyalty: LoyaltyService,
    private readonly bot: CustomerBotService,
    private readonly ctx: RequestContext,
  ) {}

  @Get('promotions')
  @RequirePermission('prices.read')
  promotions() {
    return this.loyalty.listPromotions();
  }

  @Post('promotions')
  @RequirePermission('promotions.manage')
  createPromotion(@Body() dto: PromotionDto) {
    return this.loyalty.savePromotion(null, dto as any);
  }

  @Patch('promotions/:id')
  @RequirePermission('promotions.manage')
  updatePromotion(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PromotionDto) {
    return this.loyalty.savePromotion(id, dto as any);
  }

  @Post('promotions/:id/codes')
  @RequirePermission('promotions.manage')
  @ApiOperation({ summary: 'Промокоды акции: свои или сгенерированные одноразовые' })
  codes(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CodesDto) {
    return this.loyalty.addCodes(id, dto);
  }

  @Get('cards/by-number/:number')
  @RequirePermission('customers.read')
  @ApiOperation({ summary: 'Карта по номеру (скан на кассе): клиент, баланс, уровень' })
  byNumber(@Param('number') number: string) {
    return this.loyalty.findByNumber(number);
  }

  @Get('customers/:id')
  @RequirePermission('customers.read')
  card(@Param('id', ParseUUIDPipe) id: string) {
    return this.loyalty.card(id);
  }

  @Post('customers/:id/card')
  @RequirePermission('customers.write')
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CardDto) {
    return this.loyalty.issueCard(id, dto.number);
  }

  @Post('customers/:id/adjust')
  @RequirePermission('customers.bonuses')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustDto) {
    return this.loyalty.adjust(id, dto.amount, dto.comment);
  }

  @Get('liability')
  @RequirePermission('reports.money')
  @ApiOperation({ summary: 'Бонусов на картах на сумму N (обязательство магазина)' })
  liability() {
    return this.loyalty.liability();
  }

  @Get('bot-link')
  @RequirePermission('customers.read')
  @ApiOperation({ summary: 'Ссылка для QR магазина: клиент подключается к боту' })
  botLink() {
    return this.bot.shopLink(this.ctx.requireTenantId());
  }
}

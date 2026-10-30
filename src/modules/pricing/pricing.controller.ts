import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { VersionDto } from '../../common/dto/version.dto';
import { cipher } from '../../common/pricing-engine/engine';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { SettingsService } from '../settings/settings.service';
import { PriceResolverService } from './price-resolver.service';
import { PricingAdminService } from './pricing-admin.service';

class PriceTypeDto {
  @ApiPropertyOptional({ example: 'Для таксопарков' }) @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 40) code?: string;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: 'KGS' | 'USD';
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
}
class UpdatePriceTypeDto extends PriceTypeDto {
  @ApiProperty() @IsInt() version: number;
}

class SetRateDto {
  @ApiPropertyOptional({ default: 'USD' }) @IsOptional() @IsIn(['USD', 'CNY', 'RUB', 'EUR', 'KZT']) currency?: string;
  @ApiProperty({ example: '87.40' }) @IsNumberString() rate: string;
  @ApiPropertyOptional({ example: 'Курс рынка Дордой' }) @IsOptional() @IsString() @Length(0, 200) note?: string;
}

class MarkupRuleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsIn(['original', 'oem', 'aftermarket', 'copy', 'used']) qualityClass?: string | null;
  @ApiPropertyOptional({ example: '500' }) @IsOptional() @IsNumberString() costFrom?: string | null;
  @ApiPropertyOptional({ example: '2000' }) @IsOptional() @IsNumberString() costTo?: string | null;
  @ApiPropertyOptional({ example: '30' }) @IsOptional() @IsNumberString() percent?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateMarkupRuleDto extends MarkupRuleDto {
  @ApiProperty() @IsInt() version: number;
}

class SuggestDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(1000) @IsUUID('4', { each: true }) productIds: string[];
  @ApiProperty() @IsUUID() priceTypeId: string;
  @ApiPropertyOptional({ description: 'Своя наценка вместо правил' }) @IsOptional() @IsNumberString() percent?: string;
}

class PriceSettingLineDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() priceTypeId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string | null;
  @ApiProperty({ example: '650' }) @IsNumberString() newPrice: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
}

class GenerateDto {
  @ApiProperty({ enum: ['markup', 'from_type'] }) @IsIn(['markup', 'from_type']) method: 'markup' | 'from_type';
  @ApiProperty() @IsUUID() priceTypeId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourcePriceTypeId?: string;
  @ApiPropertyOptional({ example: '-10', description: 'Наценка (markup) или ±% от другого типа (from_type)' }) @IsOptional() @IsNumberString() percent?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) productIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() onlyMissing?: boolean;
}

class PriceSettingDto {
  @ApiPropertyOptional({ description: 'Дата начала действия; будущая — цены включатся сами' }) @IsOptional() @IsISO8601() validFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) comment?: string;
  @ApiPropertyOptional({ type: [PriceSettingLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => PriceSettingLineDto) lines?: PriceSettingLineDto[];
  @ApiPropertyOptional({ type: GenerateDto }) @IsOptional() @ValidateNested() @Type(() => GenerateDto) generate?: GenerateDto;
}
class UpdatePriceSettingDto extends PriceSettingDto {
  @ApiProperty() @IsInt() version: number;
}

class PriceSettingQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'posted'] }) @IsOptional() @IsIn(['draft', 'posted']) status?: string;
}

class QuoteItemDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
}
class QuoteDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ description: 'Тип цены клиента' }) @IsOptional() @IsUUID() priceTypeId?: string;
  @ApiProperty({ type: [QuoteItemDto] }) @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QuoteItemDto) items: QuoteItemDto[];
}

class CipherDto {
  @ApiProperty({ example: '1250' }) @IsNumberString() value: string;
}

@ApiTags('Цены')
@Controller()
export class PricingController {
  constructor(
    private readonly service: PricingAdminService,
    private readonly resolver: PriceResolverService,
    private readonly tenantTx: TenantTransaction,
    private readonly settings: SettingsService,
  ) {}

  @Get('price-types')
  @RequireAnyPermission('prices.read', 'pos.use')
  priceTypes() {
    return this.service.listTypes();
  }

  @Post('price-types')
  @RequirePermission('prices.write')
  createPriceType(@Body() dto: PriceTypeDto) {
    return this.service.createType(dto);
  }

  @Patch('price-types/:id')
  @RequirePermission('prices.write')
  updatePriceType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceTypeDto) {
    return this.service.updateType(id, dto.version, dto);
  }

  @Delete('price-types/:id')
  @HttpCode(204)
  @RequirePermission('prices.write')
  async removePriceType(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.service.removeType(id, version);
  }

  @Get('rates')
  @ApiOperation({ summary: 'Курс магазина: текущий и история (виджет в шапке)' })
  rates() {
    return this.service.rates();
  }

  @Post('rates/shop')
  @RequirePermission('prices.shop_rate')
  @ApiOperation({ summary: 'Поставить курс магазина — сразу на все кассы (WebSocket rate.changed)' })
  setRate(@Body() dto: SetRateDto) {
    return this.service.setRate(dto.currency ?? 'USD', dto.rate, dto.note);
  }

  @Get('markup-rules')
  @RequirePermission('prices.write')
  rules() {
    return this.service.listRules();
  }

  @Post('markup-rules')
  @RequirePermission('prices.write')
  createRule(@Body() dto: MarkupRuleDto) {
    return this.service.createRule(dto);
  }

  @Patch('markup-rules/:id')
  @RequirePermission('prices.write')
  updateRule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMarkupRuleDto) {
    return this.service.updateRule(id, dto.version, dto);
  }

  @Delete('markup-rules/:id')
  @HttpCode(204)
  @RequirePermission('prices.write')
  async removeRule(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.service.removeRule(id, version);
  }

  @Post('prices/suggest')
  @RequirePermission('prices.write')
  @ApiOperation({ summary: 'Цена от закупки по правилам наценки (предпросмотр)' })
  suggest(@Body() dto: SuggestDto) {
    return this.tenantTx.run((tx) => this.service.suggest(tx, dto.productIds, dto.priceTypeId, dto.percent));
  }

  @Post('prices/quote')
  @RequireAnyPermission('prices.read', 'pos.use')
  @ApiOperation({ summary: 'Какая цена применяется: тип цены клиента → точка → розница; доллары → сомы по курсу' })
  quote(@Body() dto: QuoteDto) {
    return this.tenantTx.run((tx) => this.resolver.quote(tx, { storeId: dto.storeId ?? null, priceTypeId: dto.priceTypeId, items: dto.items }));
  }

  @Post('prices/cipher')
  @RequireAnyPermission('prices.write', 'stock.labels')
  @ApiOperation({ summary: 'Минимальная цена шифром владельца (для ценника)' })
  cipher(@Body() dto: CipherDto) {
    return this.tenantTx.run(async (tx) => {
      const s = await this.settings.get(tx);
      return { value: dto.value, cipher: s.minPriceCipher ? cipher(dto.value, s.minPriceCipher) : null };
    });
  }

  @Get('price-settings')
  @RequirePermission('prices.write')
  listSettings(@Query() q: PriceSettingQuery) {
    return this.service.listSettings(q);
  }

  @Post('price-settings')
  @RequirePermission('prices.write')
  @ApiOperation({ summary: 'Установка цен: строки вручную и/или сгенерировать (наценка, от другого типа)' })
  createSetting(@Body() dto: PriceSettingDto) {
    return this.service.createSetting(dto);
  }

  @Get('price-settings/:id')
  @RequirePermission('prices.write')
  getSetting(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getSetting(id);
  }

  @Patch('price-settings/:id')
  @RequirePermission('prices.write')
  updateSetting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePriceSettingDto) {
    return this.service.updateSetting(id, dto.version, dto);
  }

  @Post('price-settings/:id/post')
  @RequirePermission('prices.write')
  @ApiOperation({ summary: 'Провести установку цен; в ответе relabel — товары для перепечатки ценников' })
  postSetting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.service.postSetting(id, dto.version);
  }

  @Delete('price-settings/:id')
  @HttpCode(204)
  @RequirePermission('prices.write')
  async removeSetting(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.service.removeSetting(id, version);
  }
}

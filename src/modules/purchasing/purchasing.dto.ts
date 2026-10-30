import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { VersionDto } from '../../common/dto/version.dto';
import { PaymentDto } from '../pos/pos.dto';
import { REQUEST_STATUSES } from './entities/purchasing.entity';

const CURRENCIES = ['KGS', 'USD', 'CNY', 'AED', 'RUB', 'KZT', 'EUR'];
const csv = ({ value }: { value: unknown }) => (Array.isArray(value) ? value : String(value ?? '').split(',').filter(Boolean));

// ── Прайсы ────────────────────────────────────────────────

export class PriceListDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional({ example: 'Прайс Автомир (опт)' }) @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ enum: CURRENCIES }) @IsOptional() @IsIn(CURRENCIES) currency?: string;
  @ApiPropertyOptional({ example: 'https://supplier.kg/price.xlsx' }) @IsOptional() @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] }) url?: string | null;
  @ApiPropertyOptional({ enum: ['hourly', 'every_6h', 'daily'] }) @IsOptional() @IsIn(['hourly', 'every_6h', 'daily']) schedule?: string | null;
  @ApiPropertyOptional({ example: 3 }) @IsOptional() @IsInt() @Min(0) @Max(365) defaultLeadDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(50) headerRow?: number;
  @ApiPropertyOptional({ example: { number: 0, brand: 1, name: 2, price: 3 } }) @IsOptional() @IsObject() mapping?: Record<string, number>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdatePriceListDto extends PriceListDto {
  @ApiProperty() @IsInt() version: number;
}
export class PreviewPriceListDto {
  @ApiProperty() @IsUUID() fileId: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(50) headerRow?: number;
}
export class LoadPriceListDto {
  @ApiPropertyOptional({ description: 'Файл; без него — скачать по ссылке прайса' }) @IsOptional() @IsUUID() fileId?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() mapping?: Record<string, number>;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(50) headerRow?: number;
}
export class PriceRowsQuery extends PageQueryDto {}
export class CreateFromRowDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ example: '2500' }) @IsOptional() @IsNumberString() retailPrice?: string;
}

// ── Заказы поставщикам ────────────────────────────────────

export class OrderLineDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiProperty({ example: '10' }) @IsNumberString() qty: string;
  @ApiPropertyOptional({ example: '450' }) @IsOptional() @IsNumberString() price?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) note?: string | null;
}
export class PurchaseOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string | null;
  @ApiPropertyOptional({ enum: CURRENCIES }) @IsOptional() @IsIn(CURRENCIES) currency?: string;
  @ApiPropertyOptional({ example: '2026-11-05' }) @IsOptional() @IsISO8601() expectedAt?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) comment?: string | null;
  @ApiPropertyOptional({ type: [OrderLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines?: OrderLineDto[];
}
export class UpdatePurchaseOrderDto extends PurchaseOrderDto {
  @ApiProperty() @IsInt() version: number;
}
export class OrderStatusDto extends VersionDto {
  @ApiProperty({ enum: ['sent', 'confirmed', 'closed', 'cancelled'] }) @IsIn(['sent', 'confirmed', 'closed', 'cancelled']) status: 'sent' | 'confirmed' | 'closed' | 'cancelled';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) note?: string;
}
export class OrdersQuery extends PageQueryDto {
  @ApiPropertyOptional({ example: 'sent,confirmed' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}
export class OrderReceivingDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}
export class ExpectedQuery {
  @ApiProperty({ description: 'Через запятую' }) @Transform(csv) @IsArray() @ArrayMaxSize(500) @IsUUID('4', { each: true }) productIds: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

// ── Автозаказ ─────────────────────────────────────────────

export class AutoOrderQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional({ example: 30 }) @IsOptional() @IsInt() @Min(7) @Max(365) days?: number;
  @ApiPropertyOptional({ example: 14 }) @IsOptional() @IsInt() @Min(0) @Max(180) coverDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeWithoutRules?: boolean;
}
export class AutoOrderLineDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiProperty() @IsNumberString() qty: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() price?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional({ enum: CURRENCIES }) @IsOptional() @IsIn(CURRENCIES) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() explain?: Record<string, any>;
}
export class AutoOrderCreateDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiProperty({ type: [AutoOrderLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => AutoOrderLineDto) lines: AutoOrderLineDto[];
}

// ── Поставщики товара, правила запаса ─────────────────────

export class SupplierProductDto {
  @ApiProperty() @IsUUID() supplierId: string;
  @ApiPropertyOptional({ example: 'AM-04465' }) @IsOptional() @IsString() @Length(0, 80) supplierCode?: string | null;
  @ApiPropertyOptional({ example: '4' }) @IsOptional() @IsNumberString() multiplicity?: string;
  @ApiPropertyOptional({ example: '10' }) @IsOptional() @IsNumberString() minQty?: string;
  @ApiPropertyOptional({ example: 5 }) @IsOptional() @IsInt() @Min(0) leadDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() preferred?: boolean;
}
export class SupplierProductsDto {
  @ApiProperty({ type: [SupplierProductDto] }) @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => SupplierProductDto) items: SupplierProductDto[];
}
export class StockRuleDto {
  @ApiPropertyOptional({ description: 'Точка; не задана — для всех' }) @IsOptional() @IsUUID() storeId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minQty?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() maxQty?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() summerMin?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() summerMax?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() winterMin?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() winterMax?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string | null;
}
export class StockRulesDto {
  @ApiProperty({ type: [StockRuleDto] }) @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => StockRuleDto) rules: StockRuleDto[];
}

// ── Приёмка: доп. расходы, гарантийный возврат ────────────

export class ExtraCostsDto {
  @ApiProperty({ example: '3000' }) @IsNumberString() amount: string;
  @ApiPropertyOptional({ enum: CURRENCIES }) @IsOptional() @IsIn(CURRENCIES) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() rate?: string;
  @ApiProperty({ enum: ['sum', 'qty', 'weight', 'volume', 'manual'] }) @IsIn(['sum', 'qty', 'weight', 'volume', 'manual']) method: 'sum' | 'qty' | 'weight' | 'volume' | 'manual';
  @ApiPropertyOptional({ description: 'id строки приёмки → вес / объём на единицу или сумма (manual)' }) @IsOptional() @IsObject() values?: Record<string, string>;
  @ApiPropertyOptional({ description: 'Перевозчик — долг ему' }) @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional({ description: 'Или заплатили со счёта' }) @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional({ example: 'Доставка' }) @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) comment?: string;
}
export class WarrantyReturnDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() price?: string;
}

// ── Заявки клиентов ───────────────────────────────────────

export class RequestItemDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() id?: string;
  @ApiPropertyOptional({ example: '04465-33450' }) @IsOptional() @IsString() @Length(0, 80) number?: string | null;
  @ApiPropertyOptional({ example: 'Колодки передние' }) @IsOptional() @IsString() @Length(0, 300) name?: string;
  @ApiPropertyOptional({ example: '1' }) @IsOptional() @IsNumberString() qty?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) photoFileIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() salePrice?: string | null;
}
export class RequestDto {
  @ApiPropertyOptional({ enum: ['select', 'order'], description: 'select — «подобрать»; order — «привезти под заказ»' }) @IsOptional() @IsIn(['select', 'order']) kind?: 'select' | 'order';
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string | null;
  @ApiPropertyOptional({ example: 'Азамат' }) @IsOptional() @IsString() @Length(0, 200) customerName?: string | null;
  @ApiPropertyOptional({ example: '0555123456' }) @IsOptional() @IsString() @Length(0, 30) customerPhone?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerVehicleId?: string | null;
  @ApiPropertyOptional({ example: 'Camry 40, 2009' }) @IsOptional() @IsString() @Length(0, 200) vehicleText?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() dueAt?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 2000) comment?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string | null;
  @ApiPropertyOptional({ type: [RequestItemDto] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RequestItemDto) items?: RequestItemDto[];
}
export class UpdateRequestDto extends RequestDto {
  @ApiProperty() @IsInt() version: number;
}
export class RequestsQuery extends PageQueryDto {
  @ApiPropertyOptional({ example: 'new,ordered' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ enum: ['list', 'kanban'] }) @IsOptional() @IsIn(['list', 'kanban']) view?: 'list' | 'kanban';
}
export class OfferDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string | null;
  @ApiProperty({ example: 'Колодки Akebono' }) @IsString() @Length(1, 300) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) brand?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsIn(['original', 'oem', 'aftermarket', 'copy', 'used']) qualityClass?: string | null;
  @ApiProperty({ example: '3200' }) @IsNumberString() price: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() purchasePrice?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() leadDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() inStock?: boolean;
}
export class OffersDto extends VersionDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiProperty({ type: [OfferDto] }) @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => OfferDto) offers: OfferDto[];
}
export class ChooseDto extends VersionDto {
  @ApiProperty() @IsUUID() itemId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() offerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() salePrice?: string;
}
export class RequestOrderDto extends VersionDto {
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) itemIds?: string[];
  @ApiProperty({ enum: ['supplier', 'neighbor'] }) @IsIn(['supplier', 'neighbor']) sourceKind: 'supplier' | 'neighbor';
  @ApiProperty() @IsUUID() sourceId: string;
  @ApiPropertyOptional({ example: '1800' }) @IsOptional() @IsNumberString() purchasePrice?: string;
  @ApiPropertyOptional({ description: 'Когда привезут' }) @IsOptional() @IsISO8601() dueAt?: string;
  @ApiPropertyOptional({ description: 'Добавить в существующий черновик заказа' }) @IsOptional() @IsUUID() purchaseOrderId?: string;
}
export class RequestStatusDto extends VersionDto {
  @ApiProperty({ enum: REQUEST_STATUSES }) @IsIn(REQUEST_STATUSES) status: (typeof REQUEST_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) note?: string;
}
export class PrepayDto extends VersionDto {
  @ApiProperty({ example: '2000' }) @IsNumberString() amount: string;
  @ApiProperty({ enum: ['cash', 'card', 'transfer'] }) @IsIn(['cash', 'card', 'transfer']) method: 'cash' | 'card' | 'transfer';
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
}
export class IssueDto extends VersionDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiPropertyOptional({ type: [PaymentDto], description: 'Доплата сверх предоплаты' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentDto) payments?: PaymentDto[];
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) changeCurrency?: 'KGS' | 'USD';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(4, 8) pin?: string;
  @ApiPropertyOptional({ description: 'Сделать приёмку для позиций от поставщика, если заказ не принят (по умолчанию да)' }) @IsOptional() @IsBoolean() receive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(8, 64) idempotencyKey?: string;
}
export class RefuseDto extends VersionDto {
  @ApiProperty({ example: 'Клиент нашёл дешевле' }) @IsString() @Length(1, 500) reason: string;
  @ApiPropertyOptional({ enum: ['money', 'advance'], description: 'Предоплата: вернуть деньгами или оставить авансом' }) @IsOptional() @IsIn(['money', 'advance']) refund?: 'money' | 'advance';
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
}

// ── Лист ожидания ─────────────────────────────────────────

export class WaitlistDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ example: 'Фара левая Ipsum' }) @IsOptional() @IsString() @Length(1, 300) query?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) customerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(5, 30) customerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() qty?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) note?: string;
}
export class WaitlistStatusDto extends VersionDto {
  @ApiProperty({ enum: ['waiting', 'done', 'cancelled'] }) @IsIn(['waiting', 'done', 'cancelled']) status: 'waiting' | 'done' | 'cancelled';
}
export class WaitlistQuery {
  @ApiPropertyOptional({ example: 'waiting,notified' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
}


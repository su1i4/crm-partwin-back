import { IsObject } from 'class-validator';
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
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { VersionDto } from '../../common/dto/version.dto';
import { PAYMENT_METHODS } from './entities/receipt.entity';
import { RETURN_REASONS } from './returns.service';

export class FreeItemDto {
  @ApiProperty({ example: 'Хомут 40 мм' }) @IsString() @Length(1, 300) name: string;
}

export class NeighborItemDto {
  @ApiProperty() @IsUUID() neighborId: string;
  @ApiPropertyOptional({ example: 'Колодки передние Camry 40' }) @IsOptional() @IsString() @Length(1, 300) name?: string;
  @ApiPropertyOptional({ example: '04465-33450' }) @IsOptional() @IsString() @Length(1, 80) partNumber?: string;
  @ApiPropertyOptional({ description: 'Если уже есть карточка товара' }) @IsOptional() @IsUUID() productId?: string | null;
  @ApiProperty({ example: '1800', description: 'Цена закупки у соседа' }) @IsNumberString() purchasePrice: string;
}

export class ReceiptLineDto {
  @ApiPropertyOptional({ description: 'id строки, уже бывшей в чеке (цена сохраняется)' }) @IsOptional() @IsUUID() lineId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiProperty({ example: '1' }) @IsNumberString() qty: string;
  @ApiPropertyOptional({ description: '«Договорная» или свободная цена за единицу' }) @IsOptional() @IsNumberString() price?: string | null;
  @ApiPropertyOptional({ example: '5' }) @IsOptional() @IsNumberString() discountPercent?: string | null;
  @ApiPropertyOptional({ example: '50' }) @IsOptional() @IsNumberString() discountAmount?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) serialItemIds?: string[];
  @ApiPropertyOptional({ type: FreeItemDto }) @IsOptional() @ValidateNested() @Type(() => FreeItemDto) free?: FreeItemDto;
  @ApiPropertyOptional({ type: NeighborItemDto, description: '«Взял у соседа»' }) @IsOptional() @ValidateNested() @Type(() => NeighborItemDto) neighbor?: NeighborItemDto;
}

export class ReceiptHeaderDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerVehicleId?: string | null;
  @ApiPropertyOptional({ example: '01KG123ABC', description: 'Госномер или номер заказ-наряда СТО' }) @IsOptional() @IsString() @Length(0, 60) vehicleLabel?: string | null;
  @ApiPropertyOptional({ description: '«Привёл мастер»' }) @IsOptional() @IsUUID() masterId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceTypeId?: string | null;
  @ApiPropertyOptional({ example: '5' }) @IsOptional() @IsNumberString() receiptDiscountPercent?: string | null;
  @ApiPropertyOptional({ example: '70' }) @IsOptional() @IsNumberString() receiptDiscountAmount?: string | null;
  @ApiPropertyOptional({ example: 'Азамат, Камри' }) @IsOptional() @IsString() @Length(0, 100) label?: string | null;
  @ApiPropertyOptional({ example: 'ZIMA10', description: 'Промокод акции' }) @IsOptional() @IsString() @Length(0, 40) promoCode?: string | null;
  @ApiPropertyOptional({ example: '300', description: 'Оплатить бонусами (не больше баланса и N% чека)' }) @IsOptional() @IsNumberString() bonusAmount?: string | null;
}

export class CreateReceiptDto extends ReceiptHeaderDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiPropertyOptional({ type: [ReceiptLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines?: ReceiptLineDto[];
}

export class UpdateReceiptDto extends ReceiptHeaderDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional({ type: [ReceiptLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines?: ReceiptLineDto[];
  @ApiPropertyOptional({ description: 'PIN старшего (удаление строки по настройке)' }) @IsOptional() @IsString() @Length(4, 8) pin?: string;
}

export class PaymentDto {
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) method: (typeof PAYMENT_METHODS)[number];
  @ApiProperty({ example: '1000' }) @IsNumberString() amount: string;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'], description: 'Валюта наличных' }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
  @ApiPropertyOptional({ description: 'Кошелёк (перевод) или эквайринг (карта)' }) @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional({ description: 'Скриншот перевода' }) @IsOptional() @IsUUID() fileId?: string;
  @ApiPropertyOptional({ description: 'Обмен: чек возврата, сумма которого идёт в зачёт' }) @IsOptional() @IsUUID() sourceReceiptId?: string;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'], description: 'Долг в долларах по договорённости' }) @IsOptional() @IsIn(['KGS', 'USD']) debtCurrency?: string;
  @ApiPropertyOptional({ type: [String], description: 'Оплата авансом: позиции аванса/предоплаты' }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) advanceItemIds?: string[];
  @ApiPropertyOptional({ description: 'Зачёт лома: { productId, qty, warehouseId? } — товар «Лом АКБ» и штуки/кг' }) @IsOptional() @IsObject() scrap?: { productId: string; qty: string; warehouseId?: string | null };
}

export class PayDto extends VersionDto {
  @ApiProperty({ type: [PaymentDto] }) @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PaymentDto) payments: PaymentDto[];
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) changeCurrency?: 'KGS' | 'USD';
  @ApiPropertyOptional({ description: 'PIN старшего: скидка сверх лимита, долг сверх лимита, ниже себестоимости' }) @IsOptional() @IsString() @Length(4, 8) pin?: string;
}

export class SaleDto extends CreateReceiptDto {
  @ApiProperty({ description: 'Ключ идемпотентности: повтор — тот же чек' }) @IsString() @Length(8, 64) idempotencyKey: string;
  @ApiProperty({ type: [PaymentDto] }) @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PaymentDto) payments: PaymentDto[];
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) changeCurrency?: 'KGS' | 'USD';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(4, 8) pin?: string;
}

export class DeferDto extends VersionDto {
  @ApiPropertyOptional({ example: 'Азамат, Камри' }) @IsOptional() @IsString() @Length(0, 100) label?: string;
}
export class ResumeDto {
  @ApiProperty() @IsUUID() registerId: string;
}

export class ReceiptsQuery extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional({ example: 'open,deferred' }) @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

const csv = ({ value }: { value: unknown }) => (Array.isArray(value) ? value : String(value ?? '').split(',').filter(Boolean));
export class LastPricesQuery {
  @ApiProperty() @IsUUID() customerId: string;
  @ApiProperty({ description: 'Через запятую' }) @Transform(csv) @IsArray() @ArrayMaxSize(300) @IsUUID('4', { each: true }) productIds: string[];
}

export class ReturnLineDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() saleLineId?: string;
  @ApiPropertyOptional({ description: 'Часть комплекта: какой компонент' }) @IsOptional() @IsUUID() componentProductId?: string;
  @ApiPropertyOptional({ description: 'Без чека' }) @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional({ description: 'Без чека: цена за единицу' }) @IsOptional() @IsNumberString() price?: string;
  @ApiProperty({ example: '1' }) @IsNumberString() qty: string;
  @ApiPropertyOptional({ enum: ['ok', 'defect'] }) @IsOptional() @IsIn(['ok', 'defect']) condition?: 'ok' | 'defect';
  @ApiProperty({ enum: Object.keys(RETURN_REASONS) }) @IsIn(Object.keys(RETURN_REASONS)) reason: keyof typeof RETURN_REASONS;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() noInstallMarks?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() triedVehicleId?: string;
  @ApiPropertyOptional({ example: 'Toyota Ipsum 2003' }) @IsOptional() @IsString() @Length(1, 200) triedVehicleTitle?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) serialItemIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}

export class RefundDto {
  @ApiProperty({ enum: ['cash', 'card', 'transfer', 'return_credit'] }) @IsIn(['cash', 'card', 'transfer', 'return_credit']) method: 'cash' | 'card' | 'transfer' | 'return_credit';
  @ApiProperty() @IsNumberString() amount: string;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
}

export class CreateReturnDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiPropertyOptional({ description: 'Чек продажи (QR / номер); без него — возврат без чека по праву' }) @IsOptional() @IsUUID() saleReceiptId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiProperty({ type: [ReturnLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines: ReturnLineDto[];
  @ApiPropertyOptional({ enum: ['same', 'credit', 'custom'], description: 'same — теми же способами в той же пропорции' }) @IsOptional() @IsIn(['same', 'credit', 'custom']) refundMode?: 'same' | 'credit' | 'custom';
  @ApiPropertyOptional({ type: [RefundDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RefundDto) refunds?: RefundDto[];
  @ApiPropertyOptional({ description: 'Срок возврата прошёл — всё равно вернуть (по праву)' }) @IsOptional() @IsBoolean() confirmExpired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(4, 8) pin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(8, 64) idempotencyKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) comment?: string;
}

export class ExchangeSaleDto {
  @ApiProperty({ type: [ReceiptLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines: ReceiptLineDto[];
  @ApiPropertyOptional({ type: [PaymentDto], description: 'Доплата' }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentDto) payments?: PaymentDto[];
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) changeCurrency?: 'KGS' | 'USD';
  @ApiPropertyOptional() @IsOptional() @IsNumberString() receiptDiscountPercent?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() receiptDiscountAmount?: string;
}

export class ExchangeDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiProperty() @IsUUID() saleReceiptId: string;
  @ApiProperty({ type: [ReturnLineDto] }) @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReturnLineDto) returnLines: ReturnLineDto[];
  @ApiProperty({ type: ExchangeSaleDto }) @ValidateNested() @Type(() => ExchangeSaleDto) sale: ExchangeSaleDto;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(4, 8) pin?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmExpired?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(8, 64) idempotencyKey?: string;
}

export class FindSalesQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
}

export class WarrantyCreateDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() saleReceiptId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() saleLineId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() serialItemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional({ example: '1' }) @IsOptional() @IsNumberString() qty?: string;
  @ApiProperty({ example: 'АКБ не держит заряд через 2 месяца' }) @IsString() @Length(3, 2000) complaint: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) photoFileIds?: string[];
}
export class WarrantyStatusDto extends VersionDto {
  @ApiProperty({ enum: ['accepted', 'checking', 'sent_to_supplier'] }) @IsIn(['accepted', 'checking', 'sent_to_supplier']) status: 'accepted' | 'checking' | 'sent_to_supplier';
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplierId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) note?: string;
}
export class WarrantyDecideDto extends VersionDto {
  @ApiProperty({ enum: ['replace', 'refund', 'reject'] }) @IsIn(['replace', 'refund', 'reject']) decision: 'replace' | 'refund' | 'reject';
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) reason?: string;
  @ApiPropertyOptional({ description: 'Касса для возврата/замены' }) @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional({ description: 'Замена другой деталью' }) @IsOptional() @IsUUID() replacementProductId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Серийный экземпляр на замену' }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) serialItemIds?: string[];
}
export class WarrantyQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['accepted', 'checking', 'sent_to_supplier', 'decided'] }) @IsOptional() @IsIn(['accepted', 'checking', 'sent_to_supplier', 'decided']) status?: string;
}
export class PeriodQuery {
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

export class TransfersQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['unverified', 'verified', 'not_received'], default: 'unverified' }) @IsOptional() @IsIn(['unverified', 'verified', 'not_received']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() membershipId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}
export class VerifyDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('4', { each: true }) ids: string[];
}
export class NotReceivedDto {
  @ApiProperty({ enum: ['debt', 'cancel'], description: 'debt — в долг клиента; cancel — отменить чек' }) @IsIn(['debt', 'cancel']) action: 'debt' | 'cancel';
  @ApiPropertyOptional({ description: 'Кому записать долг, если у чека нет клиента' }) @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}
export class MatchDto {
  @ApiProperty() @IsUUID() accountId: string;
  @ApiProperty({ description: 'Загруженная выписка (Excel/CSV), purpose=import' }) @IsUUID() fileId: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() windowMinutes?: number;
}
export class LinkNeighborDto {
  @ApiProperty() @IsUUID() productId: string;
}

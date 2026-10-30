import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';
import { DOCUMENT_TYPES } from '../entities/document.entity';

const TYPES = Object.keys(DOCUMENT_TYPES);
const USER_TYPES = TYPES.filter((t) => t !== 'cost_adjustment' && t !== 'inventory');

export class SerialInputDto {
  @ApiProperty({ example: 'АКБ-2026-0001' }) @IsString() @Length(1, 80) serialNumber: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 80) inventoryNumber?: string;
  @ApiPropertyOptional({ example: 'б/у, хорошее' }) @IsOptional() @IsString() @Length(0, 100) condition?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 1000) note?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('4', { each: true }) photoFileIds?: string[];
  @ApiPropertyOptional({ description: 'Своя цена экземпляра' }) @IsOptional() @IsNumberString() price?: string;
}

export class DocumentLineDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiPropertyOptional({ description: 'Единица/упаковка; по умолчанию базовая' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiProperty({ example: '2' }) @IsNumberString() qty: string;
  @ApiPropertyOptional({ example: '450', nullable: true, description: 'Цена за единицу строки (приёмка — закупочная). null — «ожидает цен»' })
  @IsOptional()
  @IsNumberString()
  price?: string | null;
  @ApiPropertyOptional({ description: 'Пересортица: во что' }) @IsOptional() @IsUUID() productToId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Серийные экземпляры (расход)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  serialItemIds?: string[];
  @ApiPropertyOptional({ type: [SerialInputDto], description: 'Новые серийные экземпляры (приход)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => SerialInputDto)
  serials?: SerialInputDto[];
  @ApiPropertyOptional({ example: 'A-3' }) @IsOptional() @IsString() @MaxLength(50) place?: string;
  @ApiPropertyOptional({ description: 'Причина (списание)' }) @IsOptional() @IsString() @MaxLength(40) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) comment?: string;
  @ApiPropertyOptional({ description: 'Приёмка по заказу: строка заказа' }) @IsOptional() @IsUUID() orderLineId?: string;
  @ApiPropertyOptional({ description: 'Сколько ожидалось по заказу (сверка «ожидалось / пришло»)' }) @IsOptional() @IsNumberString() expectedQty?: string;
  @ApiPropertyOptional({ description: 'Цена в заказе — для подсветки разницы' }) @IsOptional() @IsNumberString() orderPrice?: string;
  @ApiPropertyOptional({ enum: ['accept', 'accept_return'], description: 'Строка «не заказана»: принять / принять и вернуть' })
  @IsOptional()
  @IsIn(['accept', 'accept_return'])
  notOrderedAction?: 'accept' | 'accept_return';
  @ApiPropertyOptional({ description: 'Брак — на склад «Брак»' }) @IsOptional() @IsBoolean() defect?: boolean;
  @ApiPropertyOptional({ enum: ['return', 'claim'], description: 'Брак: сразу возврат поставщику или претензия' })
  @IsOptional()
  @IsIn(['return', 'claim'])
  defectAction?: 'return' | 'claim';
  @ApiPropertyOptional({ description: 'Склад строки (возврат поставщику со склада «Брак»)' }) @IsOptional() @IsUUID() warehouseId?: string;
}

class DocumentHeaderDto {
  @ApiPropertyOptional({ description: 'Дата документа; по умолчанию — сейчас' }) @IsOptional() @IsDateString() docDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional({ description: 'Перемещение: куда' }) @IsOptional() @IsUUID() warehouseToId?: string;
  @ApiPropertyOptional({ description: 'Поставщик / контрагент' }) @IsOptional() @IsUUID() counterpartyId?: string | null;
  @ApiPropertyOptional({ enum: ['KGS', 'USD', 'CNY', 'AED', 'RUB', 'KZT'] })
  @IsOptional()
  @IsIn(['KGS', 'USD', 'CNY', 'AED', 'RUB', 'KZT'])
  currency?: string;
  @ApiPropertyOptional({ example: '87.40', description: 'Курс документа к сому' }) @IsOptional() @IsNumberString() rate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) comment?: string | null;
  @ApiPropertyOptional({
    description:
      'Особые поля вида. Приёмка: supplierInvoiceNumber, supplierInvoiceDate, extraCosts [{name, amount}], extraCostsCurrency kgs|doc. Списание: reason',
  })
  @IsOptional()
  @IsObject()
  extra?: Record<string, any>;

  @ApiPropertyOptional({ type: [DocumentLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => DocumentLineDto)
  lines?: DocumentLineDto[];
}

export class CreateDocumentDto extends DocumentHeaderDto {
  @ApiProperty({ enum: USER_TYPES }) @IsIn(USER_TYPES) type: string;
  @ApiPropertyOptional({ description: 'Сразу провести' }) @IsOptional() @IsBoolean() post?: boolean;
  @ApiPropertyOptional({ description: 'Создан на основании' }) @IsOptional() @IsUUID() baseDocumentId?: string;
  @ApiPropertyOptional({ description: 'Подтверждаю: накладная поставщика уже была' }) @IsOptional() @IsBoolean() confirmDuplicateInvoice?: boolean;
}

export class UpdateDocumentDto extends DocumentHeaderDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmDuplicateInvoice?: boolean;
}

export class PostDocumentDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmDuplicateInvoice?: boolean;
}

export class AcceptTransferDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional({ description: 'Сколько принято по строкам (в базовой единице). Не задано — всё' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AcceptLineDto)
  lines?: AcceptLineDto[];
}

export class AcceptLineDto {
  @ApiProperty() @IsUUID() lineId: string;
  @ApiProperty({ example: '3' }) @IsNumberString() qty: string;
}

export class BasedOnDto {
  @ApiProperty({ enum: ['transfer', 'writeoff', 'receiving', 'surplus'] }) @IsIn(['transfer', 'writeoff', 'receiving', 'surplus']) type: string;
}

export class AttachmentDto {
  @ApiProperty() @IsUUID() fileId: string;
}

export class DocumentListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: TYPES }) @IsOptional() @IsIn(TYPES) type?: string;
  @ApiPropertyOptional({ enum: ['draft', 'awaiting_approval', 'posted'] }) @IsOptional() @IsIn(['draft', 'awaiting_approval', 'posted']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() deletionMark?: boolean;
  @ApiPropertyOptional({ description: 'Только перемещения «в пути»' }) @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() inTransit?: boolean;
}

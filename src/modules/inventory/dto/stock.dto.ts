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
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';

const bool = ({ value }: { value: unknown }) => (value === undefined ? undefined : value === true || value === 'true' || value === '1');

export class StockQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @Transform(bool) @IsBoolean() onlyPositive?: boolean;
  @ApiPropertyOptional({ description: 'Только ушедшие в минус' }) @IsOptional() @Transform(bool) @IsBoolean() onlyNegative?: boolean;
}

export class AtDateQueryDto extends PageQueryDto {
  @ApiProperty({ example: '2026-09-30T23:59:59+06:00' }) @IsDateString() date: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
}

export class TurnoverQueryDto extends PageQueryDto {
  @ApiProperty() @IsDateString() from: string;
  @ApiProperty() @IsDateString() to: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
}

export class MovementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
}

export class SetPlaceDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(5000) @IsUUID('4', { each: true }) productIds: string[];
  @ApiPropertyOptional({ example: 'A-3', nullable: true, description: 'Пусто — убрать место' }) @IsOptional() @IsString() @MaxLength(50) place?: string | null;
}

export class StockControlItemDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ example: '7' }) @IsNumberString() qty: string;
  @ApiPropertyOptional({ example: '450', description: 'Себестоимость за единицу' }) @IsOptional() @IsNumberString() unitCost?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) place?: string;
}

export class EnableStockControlDto {
  @ApiProperty({ type: [StockControlItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockControlItemDto)
  items: StockControlItemDto[];
}

export class CreateInventoryDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiPropertyOptional({ description: 'Частичная: категория (с подкатегориями)' }) @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional({ description: 'Место хранения (полка)' }) @IsOptional() @IsString() @MaxLength(50) place?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) productIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) comment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) sheetName?: string;
}

export class SheetDto {
  @ApiProperty({ example: 'Ряд B' }) @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assignedTo?: string;
}

export class CountDto {
  @ApiProperty() @IsUUID() sheetId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ description: 'Скан штрихкода вместо productId' }) @IsOptional() @IsString() @Length(4, 64) barcode?: string;
  @ApiProperty({ example: '1' }) @IsNumberString() qty: string;
  @ApiPropertyOptional({ enum: ['add', 'set'], default: 'add' }) @IsOptional() @IsIn(['add', 'set']) mode?: 'add' | 'set';
  @ApiPropertyOptional({ description: 'Время скана на устройстве' }) @IsOptional() @IsDateString() scannedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() serialItemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) place?: string;
}

export class FinishInventoryDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional({ default: true, description: 'Непосчитанные товары области — ноль (недостача)' })
  @IsOptional()
  @IsBoolean()
  uncountedAsZero?: boolean;
}

export class ClosePeriodDto {
  @ApiProperty({ example: '2026-09' }) @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month: string;
}

export class ReopenPeriodDto extends ClosePeriodDto {
  @ApiProperty({ example: 'Нашли непроведённую накладную' }) @IsString() @Length(3, 500) reason: string;
}

export class ProductLabelsDto {
  @ApiProperty({ type: [Object], example: [{ productId: '…', copies: 3 }] })
  @IsArray()
  @ArrayMaxSize(500)
  items: { productId: string; unitId?: string; copies: number; warehouseId?: string }[];
  @ApiPropertyOptional({ example: 58 }) @IsOptional() @IsInt() w?: number;
  @ApiPropertyOptional({ example: 40 }) @IsOptional() @IsInt() h?: number;
}

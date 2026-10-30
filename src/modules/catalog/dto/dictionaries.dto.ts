import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ATTRIBUTE_VALUE_TYPES, AttributeValueType } from '../entities/part-type.entity';

export class CreateBrandDto {
  @ApiProperty({ example: 'Masuma' }) @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional({ type: [String], example: ['Масума'] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) aliases?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 60) country?: string;
  @ApiPropertyOptional({ description: 'Подключить бренд из общего справочника' }) @IsOptional() @IsUUID() globalBrandId?: string;
}

export class UpdateBrandDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) aliases?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 60) country?: string;
}

export class CategorySettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) warrantyDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) returnDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) returnConditions?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pairHint?: boolean;
  @ApiPropertyOptional({ enum: ['forbid', 'warn'] }) @IsOptional() @IsIn(['forbid', 'warn']) negativeStock?: 'forbid' | 'warn' | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() noStockControl?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requireNoInstallMarks?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() universal?: boolean;
}

export class CreateCategoryDto {
  @ApiProperty({ example: 'Пыльники рулевой рейки' }) @IsString() @Length(1, 200) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
  @ApiPropertyOptional({ type: CategorySettingsDto }) @IsOptional() @ValidateNested() @Type(() => CategorySettingsDto) settings?: CategorySettingsDto;
}

export class UpdateCategoryDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ nullable: true, description: 'null — в корень' }) @IsOptional() @IsUUID() parentId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
  @ApiPropertyOptional({ type: CategorySettingsDto }) @IsOptional() @ValidateNested() @Type(() => CategorySettingsDto) settings?: CategorySettingsDto;
}

export class AttributeDto {
  @ApiProperty({ example: 'Количество зубьев' }) @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional({ example: 'teeth' }) @IsOptional() @IsString() @Length(1, 60) code?: string;
  @ApiProperty({ enum: ATTRIBUTE_VALUE_TYPES }) @IsIn(ATTRIBUTE_VALUE_TYPES) valueType: AttributeValueType;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 20) unit?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() filterable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() searchable?: boolean;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) options?: string[];
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
}

export class UpdateAttributeDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional({ enum: ATTRIBUTE_VALUE_TYPES }) @IsOptional() @IsIn(ATTRIBUTE_VALUE_TYPES) valueType?: AttributeValueType;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 20) unit?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() required?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() filterable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() searchable?: boolean;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
}

export class CreatePartTypeDto {
  @ApiProperty({ example: 'Ремень ГРМ' }) @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 60) code?: string;
  @ApiPropertyOptional({ type: [AttributeDto] }) @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AttributeDto) attributes?: AttributeDto[];
}

export class UpdatePartTypeDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sort?: number;
}

export class BulkUpdateDto {
  @ApiPropertyOptional({ type: [String], description: 'Выбранные товары; или filter' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @IsUUID('4', { each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'Фильтр как у GET /products (без пагинации)' }) @IsOptional() @IsObject() filter?: Record<string, unknown>;

  @ApiProperty({ example: { categoryId: '…', qualityClass: 'oem', addTags: ['акция'] } })
  @IsObject()
  set: {
    categoryId?: string | null;
    brand?: string;
    qualityClass?: string;
    partTypeId?: string | null;
    status?: 'active' | 'archived';
    attributes?: Record<string, unknown>;
    addTags?: string[];
    removeTags?: string[];
    noStockControl?: boolean;
    priceNegotiable?: boolean;
  };
}

export class MergeDto {
  @ApiProperty({ type: [String], description: 'Дубли, которые сливаются в этот товар' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  duplicateIds: string[];
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';
import { QUALITY_CLASSES, QualityClass } from '../entities/product.entity';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => (value === undefined ? undefined : value === true || value === 'true' || value === '1');

export class UnitInputDto {
  @ApiProperty({ example: 'упаковка' }) @Transform(trim) @IsString() @Length(1, 30) name: string;
  @ApiProperty({ example: '4', description: 'Сколько базовых единиц' }) @IsNumberString() factor: string;
  @ApiPropertyOptional({ enum: ['computed', 'own'] }) @IsOptional() @IsIn(['computed', 'own']) priceMode?: 'computed' | 'own';
  @ApiPropertyOptional({ description: 'Штрихкод этой упаковки' }) @IsOptional() @IsString() @Length(4, 64) barcode?: string;
}

export class KitComponentDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty({ example: '1' }) @IsNumberString() qty: string;
}

export class ApplicabilityItemDto {
  @ApiPropertyOptional({ description: 'Текст «для каких машин»: «камри 40», «Toyota Camry»' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  text?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() generationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modificationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1950) @Max(2100) yearFrom?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1950) @Max(2100) yearTo?: number;
  @ApiPropertyOptional({ enum: ['right', 'left'] }) @IsOptional() @IsIn(['right', 'left']) steering?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10) market?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class PriceInputDto {
  @ApiProperty() @IsUUID() priceTypeId: string;
  @ApiPropertyOptional({ description: 'Точка; не задана — для всех точек' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ description: 'Единица со своей ценой' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiProperty({ example: '650' }) @IsNumberString() price: string;
  @ApiPropertyOptional({ enum: ['KGS', 'USD'] }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
}

class ProductFieldsDto {
  @ApiPropertyOptional({ example: '005123', description: 'Артикул; не задан — создастся сам' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 50)
  sku?: string;

  @ApiPropertyOptional({ enum: ['goods', 'service', 'kit'] }) @IsOptional() @IsIn(['goods', 'service', 'kit']) kind?: 'goods' | 'service' | 'kit';
  @ApiPropertyOptional({ description: 'Бренд по названию (свой / глобальный / создастся)' }) @IsOptional() @Transform(trim) @IsString() @Length(1, 100) brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional({ enum: QUALITY_CLASSES }) @IsOptional() @IsIn(QUALITY_CLASSES) qualityClass?: QualityClass;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() partTypeId?: string | null;
  @ApiPropertyOptional({ example: { side: 'Левая', sae: '5W-30' } }) @IsOptional() @IsObject() attributes?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) sellerNote?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) warrantyDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) returnDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) returnConditions?: string | null;
  @ApiPropertyOptional({ example: 'шт' }) @IsOptional() @IsIn(['шт', 'л', 'м', 'кг', 'компл', 'пара']) baseUnit?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() fractional?: boolean;
  @ApiPropertyOptional({ example: '0.1' }) @IsOptional() @IsNumberString() qtyStep?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isSerial?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() noStockControl?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() priceNegotiable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() minPrice?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() recommendedPrice?: string | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) tags?: string[];

  @ApiPropertyOptional({ example: '0 986-452.041', description: 'Номер производителя (у «Без бренда» — копируемый OEM)' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  number?: string;

  @ApiPropertyOptional({ type: [String], example: ['90915-YZZE1'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  oemNumbers?: string[];

  @ApiPropertyOptional({ type: [KitComponentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KitComponentDto)
  kitComponents?: KitComponentDto[];

  @ApiPropertyOptional({ type: [ApplicabilityItemDto], description: 'Применимость (заменяет текущую)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ApplicabilityItemDto)
  applicability?: ApplicabilityItemDto[];

  @ApiPropertyOptional({ type: [String], description: 'Фото — id файлов (до 10)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  photoFileIds?: string[];
}

export class CreateProductDto extends ProductFieldsDto {
  @ApiProperty({ example: 'Фильтр масляный' }) @Transform(trim) @IsString() @Length(1, 300) name: string;

  @ApiPropertyOptional({ type: [String], description: 'Штрихкоды базовой единицы' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  barcodes?: string[];

  @ApiPropertyOptional({ description: 'Выдать внутренний EAN-13, если штрихкода нет' }) @IsOptional() @IsBoolean() generateBarcode?: boolean;

  @ApiPropertyOptional({ type: [UnitInputDto], description: 'Упаковки кроме базовой' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnitInputDto)
  units?: UnitInputDto[];

  @ApiPropertyOptional({ example: '650', description: 'Розничная цена базовой единицы' }) @IsOptional() @IsNumberString() retailPrice?: string;

  @ApiPropertyOptional({ description: 'Сохранить, даже если штрихкод уже есть у другого товара' }) @IsOptional() @IsBoolean() confirmDuplicateBarcode?: boolean;
}

export class UpdateProductDto extends ProductFieldsDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 300) name?: string;
  @ApiPropertyOptional({ enum: ['active', 'archived'] }) @IsOptional() @IsIn(['active', 'archived']) status?: 'active' | 'archived';
}

/** Быстрое создание за 10–15 секунд (ТЗ 4.7). */
export class QuickCreateProductDto {
  @ApiProperty({ example: 'Колодки передние' }) @Transform(trim) @IsString() @Length(1, 300) name: string;
  @ApiPropertyOptional({ example: '04465-33450' }) @IsOptional() @IsString() @Length(1, 80) number?: string;
  @ApiPropertyOptional({ example: 'Toyota' }) @IsOptional() @Transform(trim) @IsString() @Length(1, 100) brand?: string;
  @ApiPropertyOptional({ example: '2500' }) @IsOptional() @IsNumberString() price?: string;
  @ApiPropertyOptional({ enum: QUALITY_CLASSES }) @IsOptional() @IsIn(QUALITY_CLASSES) qualityClass?: QualityClass;
  @ApiPropertyOptional({ type: [String], example: ['камри 40'], description: '«Для каких машин»' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  vehicles?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() photoFileId?: string;
  @ApiPropertyOptional({ description: 'Отсканированный штрихкод' }) @IsOptional() @IsString() @Length(4, 64) barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() noStockControl?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmDuplicateBarcode?: boolean;
}

export class ProductListQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() partTypeId?: string;
  @ApiPropertyOptional({ enum: QUALITY_CLASSES }) @IsOptional() @IsIn(QUALITY_CLASSES) qualityClass?: QualityClass;
  @ApiPropertyOptional({ enum: ['active', 'archived', 'all'], default: 'active' }) @IsOptional() @IsIn(['active', 'archived', 'all']) status?: string;
  @ApiPropertyOptional({ enum: ['goods', 'service', 'kit'] }) @IsOptional() @IsIn(['goods', 'service', 'kit']) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() tag?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() generationId?: string;
  @ApiPropertyOptional({ description: 'Ветка «Универсальное» / «Без привязки к авто»', enum: ['universal', 'no_vehicle'] })
  @IsOptional()
  @IsIn(['universal', 'no_vehicle'])
  vehicleBranch?: 'universal' | 'no_vehicle';
  @ApiPropertyOptional({ description: 'Чего не хватает: price,photo,number,category,applicability (через запятую)' })
  @IsOptional()
  @IsString()
  missing?: string;
  @ApiPropertyOptional({ description: 'Фильтр по атрибутам JSON: {"side":"Левая"}' }) @IsOptional() @IsString() attributes?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() quickCreated?: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(bool) @IsBoolean() noStockControl?: boolean;
}

export class BarcodeAddDto {
  @ApiPropertyOptional({ description: 'Не задан — выдать внутренний EAN-13' }) @IsOptional() @IsString() @Length(4, 64) barcode?: string;
  @ApiPropertyOptional({ description: 'Единица; по умолчанию — базовая' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmDuplicate?: boolean;
}

export class UnitUpdateDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 30) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() factor?: string;
  @ApiPropertyOptional({ enum: ['computed', 'own'] }) @IsOptional() @IsIn(['computed', 'own']) priceMode?: 'computed' | 'own';
}

export class SetPricesDto {
  @ApiProperty({ type: [PriceInputDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PriceInputDto)
  items: PriceInputDto[];
}

export class PhotosDto {
  @ApiProperty({ type: [String], description: 'Порядок фото — id файлов' })
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  fileIds: string[];
}

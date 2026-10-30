import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { WAREHOUSE_TYPES, WarehouseType } from '../entities/warehouse.entity';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateStoreDto {
  @ApiProperty({ example: 'Ош-1' }) @Transform(trim) @IsString() @Length(1, 200) name: string;
  @ApiPropertyOptional({ example: 'ОШ', description: 'Код для номеров документов, создаётся сам' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-zА-Яа-яЁёҢңӨөҮү0-9]{1,10}$/, { message: 'Код: буквы и цифры, до 10 символов' })
  code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 50) phone?: string;
  @ApiPropertyOptional({ default: 'Asia/Bishkek' }) @IsOptional() @IsString() timezone?: string;
  @ApiPropertyOptional({ default: true, description: 'Создать торговый зал и кассу' })
  @IsOptional()
  @IsBoolean()
  createDefaults?: boolean;
}

export class UpdateStoreDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-zА-Яа-яЁёҢңӨөҮү0-9]{1,10}$/)
  code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 50) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateWarehouseDto {
  @ApiPropertyOptional({ description: 'Точка; не задана — центральный склад' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiProperty({ example: 'Подсобка' }) @Transform(trim) @IsString() @Length(1, 200) name: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 20) code?: string;
  @ApiProperty({ enum: WAREHOUSE_TYPES }) @IsIn(WAREHOUSE_TYPES) type: WarehouseType;
  @ApiPropertyOptional({ enum: [1, 2, 3] }) @IsOptional() @IsInt() @Min(1) @Max(3) storageLevel?: number;
}

export class UpdateWarehouseDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 20) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateRegisterDto {
  @ApiProperty() @IsUUID() storeId: string;
  @ApiPropertyOptional({ example: 'Касса 2' }) @IsOptional() @Transform(trim) @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional({ example: 'К2' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-zА-Яа-яЁё0-9]{1,6}$/, { message: 'Код кассы: буквы и цифры, до 6 символов' })
  code?: string;
  @ApiPropertyOptional({ description: 'Склад списания; по умолчанию — торговый зал точки' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}

export class UpdateRegisterDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class StoreFilterDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeInactive?: boolean;
}

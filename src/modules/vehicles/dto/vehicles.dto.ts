import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
import { ApplicabilityItemDto } from '../../catalog/dto/product.dto';

export class CreateTenantModelDto {
  @ApiProperty() @IsUUID() makeId: string;
  @ApiProperty({ example: 'Hiace Regius' }) @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) aliases?: string[];
}

export class CreateTenantGenerationDto {
  @ApiProperty({ description: 'Модель — общая или своя' }) @IsUUID() modelId: string;
  @ApiProperty({ example: 'H40' }) @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1950) @Max(2100) yearFrom?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1950) @Max(2100) yearTo?: number;
  @ApiPropertyOptional({ enum: ['pre', 'post'] }) @IsOptional() @IsIn(['pre', 'post']) restyle?: 'pre' | 'post';
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) aliases?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) bodyCodes?: string[];
}

export class ApplicabilityBulkDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  productIds: string[];

  @ApiProperty({ type: [ApplicabilityItemDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApplicabilityItemDto)
  items: ApplicabilityItemDto[];
}

export class ApplicabilityReplaceDto {
  @ApiProperty({ type: [ApplicabilityItemDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ApplicabilityItemDto)
  items: ApplicabilityItemDto[];
}

export class ApplicabilityCopyDto {
  @ApiProperty({ type: [String], description: 'Куда скопировать' })
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  toProductIds: string[];
}

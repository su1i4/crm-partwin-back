import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'Старший продавец' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiProperty({ type: [String], example: ['pos.use', 'products.read'] })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions: string[];

  @ApiPropertyOptional({ description: 'Лимит ручной скидки, %', default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDiscountPercent?: number;
}

export class UpdateRoleDto {
  @ApiProperty({ description: 'Версия роли (оптимистичная блокировка)' })
  @IsInt()
  version: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDiscountPercent?: number;
}

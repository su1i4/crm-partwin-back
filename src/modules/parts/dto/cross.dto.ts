import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateCrossDto {
  @ApiPropertyOptional({ example: 'Bosch' }) @IsOptional() @IsString() @Length(1, 100) aBrand?: string;
  @ApiProperty({ example: '0 986 452 041' }) @IsString() @Length(1, 80) aNumber: string;
  @ApiPropertyOptional({ example: 'Toyota' }) @IsOptional() @IsString() @Length(1, 100) bBrand?: string;
  @ApiProperty({ example: '90915-YZZE1' }) @IsString() @Length(1, 80) bNumber: string;
  @ApiPropertyOptional({ enum: ['full', 'partial', 'oem_replacement'], default: 'full' })
  @IsOptional()
  @IsIn(['full', 'partial', 'oem_replacement'])
  crossType?: 'full' | 'partial' | 'oem_replacement';
}

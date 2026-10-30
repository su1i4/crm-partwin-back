import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ example: 'ИП', enum: ['ИП', 'ОсОО', 'другое'] })
  @IsOptional()
  @IsIn(['ИП', 'ОсОО', 'другое'])
  legalForm?: string;
  @ApiPropertyOptional({ example: '21234567890123' })
  @IsOptional()
  @Matches(/^\d{10,14}$/, { message: 'ИНН — 10–14 цифр' })
  inn?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 50) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) city?: string;
  @ApiPropertyOptional({ example: { bank: 'Оптима Банк', account: '1091…', bik: '109018' } })
  @IsOptional()
  @IsObject()
  requisites?: Record<string, string>;
  @ApiPropertyOptional({ description: 'Логотип — id файла (purpose=logo)' }) @IsOptional() @IsUUID() logoFileId?: string;
  @ApiPropertyOptional({ enum: ['ru', 'ky'] }) @IsOptional() @IsIn(['ru', 'ky']) language?: string;
}

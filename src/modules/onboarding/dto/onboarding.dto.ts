import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import type { ShopType } from '../../tenants/entities/tenant.entity';

export class OnboardingWalletDto {
  @ApiProperty({ example: 'MBank', description: 'Сервис: MBank, O!Деньги, Optima, Элсом …' })
  @IsString()
  @Length(1, 60)
  provider: string;

  @ApiProperty({ example: 'Азамат' }) @IsString() @Length(1, 100) holderName: string;

  @ApiProperty({ example: '0555123456' }) @IsString() @Length(5, 30) phone: string;
}

export class CompleteOnboardingDto {
  @ApiPropertyOptional({ description: 'Название магазина (шаг 2)' }) @IsOptional() @IsString() @Length(1, 200) shopName?: string;
  @ApiPropertyOptional({ example: 'Бишкек' }) @IsOptional() @IsString() @Length(1, 100) city?: string;
  @ApiPropertyOptional({ enum: ['ru', 'ky'] }) @IsOptional() @IsIn(['ru', 'ky']) language?: string;

  @ApiProperty({ enum: ['container', 'city', 'wholesale'], description: 'Тип магазина (шаг 3)' })
  @IsIn(['container', 'city', 'wholesale'])
  shopType: ShopType;

  @ApiPropertyOptional({ type: [String], example: ['toyota', 'lexus', 'honda'], description: 'Наши марки (шаг 4)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ourMakes?: string[];

  @ApiPropertyOptional({ description: 'Название первой точки (шаг 5)' }) @IsOptional() @IsString() @Length(1, 200) storeName?: string;
  @ApiPropertyOptional({ example: 'ДОР', description: 'Код точки для номеров документов' })
  @IsOptional()
  @Matches(/^[A-Za-zА-Яа-яЁёҢңӨөҮү0-9]{1,10}$/)
  storeCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) storeAddress?: string;

  @ApiPropertyOptional({ example: '87.40', description: 'Курс магазина, сом за 1 USD (шаг 7)' })
  @IsOptional()
  @IsNumberString()
  shopRateUsd?: string;

  @ApiPropertyOptional({ type: [OnboardingWalletDto], description: 'Кошельки для переводов (шаг 7)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OnboardingWalletDto)
  wallets?: OnboardingWalletDto[];
}

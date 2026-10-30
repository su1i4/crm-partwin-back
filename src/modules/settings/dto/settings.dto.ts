import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class MakeGroupDto {
  @ApiProperty({ example: 'Японские' }) @IsString() @Length(1, 60) name: string;
  @ApiProperty({ type: [String], example: ['toyota', 'honda'] }) @IsArray() @IsString({ each: true }) makes: string[];
}

/** Частичное изменение настроек магазина. Все поля необязательны. */
export class UpdateSettingsDto {
  @ApiProperty({ description: 'Версия настроек' }) @IsInt() version: number;

  @ApiPropertyOptional({ enum: ['forbid', 'warn'] }) @IsOptional() @IsIn(['forbid', 'warn']) negativeStock?: 'forbid' | 'warn';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) editOldDocumentsDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(60) reserveDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() periodCloseReminder?: boolean;
  @ApiPropertyOptional({ description: 'Списание дороже суммы — на согласование; 0 — без' }) @IsOptional() @IsInt() @Min(0) writeoffApprovalAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(90) transferStaleDays?: number;

  @ApiPropertyOptional({ enum: ['forbid', 'confirm', 'allow'] })
  @IsOptional()
  @IsIn(['forbid', 'confirm', 'allow'])
  belowCostSale?: 'forbid' | 'confirm' | 'allow';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowFreeItems?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowQuickCreateAtPos?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowOcr?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() deleteLineRequiresPin?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() cashHandover?: boolean;
  @ApiPropertyOptional({ example: '23:00', nullable: true })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  shiftAutoCloseTime?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() returnInOtherStore?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() repeatScanIncrements?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(60) selectionIssueDays?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(365) creditBlockOverdueDays?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) @Max(1440) transferMatchWindowMinutes?: number;
  @ApiPropertyOptional({ type: [Number] }) @IsOptional() @IsArray() @IsInt({ each: true }) quickBanknotes?: number[];
  @ApiPropertyOptional({ type: [Number], example: [4, 5, 6, 7, 8, 9] }) @IsOptional() @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) @Max(12, { each: true }) summerMonths?: number[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(7) @Max(365) autoOrderSalesDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(180) autoOrderCoverDays?: number;

  @ApiPropertyOptional({ enum: [1, 5, 10] }) @IsOptional() @IsIn([1, 5, 10]) priceRounding?: 1 | 5 | 10;
  @ApiPropertyOptional({ enum: ['KGS', 'USD', 'both'] })
  @IsOptional()
  @IsIn(['KGS', 'USD', 'both'])
  priceTagCurrency?: 'KGS' | 'USD' | 'both';
  @ApiPropertyOptional({ example: 'ПОЛУСТАНЕК', description: '10 разных букв: i-я буква = цифра i', nullable: true })
  @IsOptional()
  @IsString()
  minPriceCipher?: string | null;

  @ApiPropertyOptional({ enum: ['groups', 'makes'] }) @IsOptional() @IsIn(['groups', 'makes']) catalogDefaultView?: 'groups' | 'makes';
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ourMakes?: string[];
  @ApiPropertyOptional({ enum: ['make', 'model', 'generation', 'modification'] })
  @IsOptional()
  @IsIn(['make', 'model', 'generation', 'modification'])
  makeTreeDepth?: 'make' | 'model' | 'generation' | 'modification';
  @ApiPropertyOptional({ type: [MakeGroupDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MakeGroupDto)
  makeGroups?: MakeGroupDto[];

  @ApiPropertyOptional({ enum: [1, 2, 3] }) @IsOptional() @IsIn([1, 2, 3]) defaultStorageLevel?: 1 | 2 | 3;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1000) @Max(200000) offlineProductLimit?: number;
  @ApiPropertyOptional({ example: '21:00' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  eveningSummaryTime?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() loyaltyEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(50) bonusAccrualPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) bonusMaxPayPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(3650) bonusExpireDays?: number;
  @ApiPropertyOptional({ example: [{ name: 'Золото', threshold: '100000', percent: '5' }] }) @IsOptional() @IsArray() loyaltyLevels?: { name: string; threshold: string; percent: string }[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(60) selectionDays?: number;
}

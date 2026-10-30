import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';

export class StaffQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'disabled'] })
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roleId?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  roleIds?: string[];

  @ApiPropertyOptional({ description: 'Доступ ко всем точкам' })
  @IsOptional()
  @IsBoolean()
  allStores?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Точки (если не allStores)' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  storeIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Сужение до складов; пусто — все склады точек' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  warehouseIds?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) position?: string;
}

export class CreateInvitationDto {
  @ApiPropertyOptional({ description: 'Телефон или email: принять сможет только он. Не задан — любой по коду' })
  @IsOptional()
  @IsString()
  @Length(3, 200)
  login?: string;

  @ApiPropertyOptional({ example: 'Азамат' }) @IsOptional() @IsString() @Length(1, 200) name?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  roleIds: string[];

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() allStores?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  storeIds?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 100) position?: string;

  @ApiPropertyOptional({ default: 7 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}

export class TransferOwnershipDto {
  @ApiProperty({ description: 'Участие нового владельца' }) @IsUUID() membershipId: string;
  @ApiProperty({ description: 'Ваш пароль для подтверждения' }) @IsString() password: string;
  @ApiPropertyOptional({ description: 'Код из Telegram — если Telegram привязан' }) @IsOptional() @IsString() @Length(6, 6) telegramCode?: string;
}

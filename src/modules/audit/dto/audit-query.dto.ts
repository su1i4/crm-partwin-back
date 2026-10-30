import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';

export class AuditQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ description: 'Действие или его начало: settings. / role.update' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ description: 'Только важные действия' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  important?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

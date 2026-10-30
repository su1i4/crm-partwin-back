import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsObject, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/pagination.dto';

export class NotificationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unreadOnly?: boolean;
}

export class MarkReadDto {
  @ApiPropertyOptional({ type: [String], description: 'Пусто или не задано — отметить все' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  ids?: string[];
}

export class ChannelsDto {
  @ApiProperty()
  @IsBoolean()
  inApp: boolean;

  @ApiProperty()
  @IsBoolean()
  telegram: boolean;
}

export class SetChannelsDto {
  @ApiProperty({
    description: 'Событие → каналы',
    example: { 'settings.changed': { inApp: true, telegram: false } },
  })
  // Ключи — типы событий: @Type(ChannelsDto) на словаре превращал его в один объект и whitelist стирал ключи.
  // Значения проверяются в сервисе.
  @IsObject()
  channels: Record<string, ChannelsDto>;
}

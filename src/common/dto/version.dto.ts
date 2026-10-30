import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/** Версия, которую видел клиент (оптимистичная блокировка, ТЗ 2.4.12). */
export class VersionDto {
  @ApiProperty({ description: 'Текущая версия записи (поле version)' })
  @IsInt()
  @Min(1)
  version: number;
}

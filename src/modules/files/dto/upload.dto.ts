import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { FILE_PURPOSES, FilePurpose } from '../files.service';

/** Поля формы рядом с файлом (сам файл — поле file, multipart). */
export class UploadFileDto {
  @ApiProperty({ enum: FILE_PURPOSES })
  @IsIn(FILE_PURPOSES)
  purpose: FilePurpose;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
}

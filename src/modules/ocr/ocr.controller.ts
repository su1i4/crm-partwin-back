import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { OcrService } from './ocr.service';

const CONTEXTS = ['pos', 'receiving', 'inventory', 'search', 'product', 'garage'];

export class OcrRecognizeDto {
  @ApiPropertyOptional({ description: 'Уже загруженное фото (вместо file)' }) @IsOptional() @IsUUID() fileId?: string;
  @ApiPropertyOptional({ enum: CONTEXTS }) @IsOptional() @IsIn(CONTEXTS) context?: string;
}

export class OcrCorrectionDto {
  @ApiPropertyOptional({ example: '90915YZZE1' }) @IsOptional() @IsString() @Length(1, 80) correctedText?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() chosenProductId?: string;
}

export class OcrStatsQuery {
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(365) days?: number;
}

@ApiTags('Распознавание номера с фото')
@Controller('ocr')
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @Get('status')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Включено ли распознавание (кнопка камеры на кассе)' })
  status() {
    return this.ocr.status();
  }

  @Post('recognize')
  @RequirePermission('products.read')
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, fileId: { type: 'string', format: 'uuid' }, context: { type: 'string', enum: CONTEXTS } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  @ApiOperation({ summary: 'Фото этикетки / детали → номера → товары и поставщики. 503 OCR_UNAVAILABLE — ввод вручную' })
  recognize(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: OcrRecognizeDto) {
    return this.ocr.recognize({ file, fileId: dto.fileId, context: dto.context });
  }

  @Post(':id/correction')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Исправленный номер / выбранный товар — статистика качества' })
  correction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OcrCorrectionDto) {
    return this.ocr.correction(id, dto);
  }

  @Get('stats')
  @RequirePermission('reports.sales')
  @ApiOperation({ summary: 'Качество распознавания за период' })
  stats(@Query() q: OcrStatsQuery) {
    return this.ocr.stats(q.days);
  }
}

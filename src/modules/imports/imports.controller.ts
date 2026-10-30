import { IMPORT_TEMPLATES } from './import-fields';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { ImportsService } from './imports.service';

class ImportOptionsDto {
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() updateExisting?: boolean;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() createCategories?: boolean;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) headerRow?: number;
}

class CreateImportDto {
  @ApiProperty({ enum: ['products', 'crosses', 'applicability'] }) @IsIn(['products', 'crosses', 'applicability']) type: 'products' | 'crosses' | 'applicability';
  @ApiProperty({ description: 'Загруженный файл (POST /files, purpose=import)' }) @IsUUID() fileId: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) headerRow?: number;
}

class PreviewImportDto {
  @ApiProperty({ example: { name: 0, number: 1, brand: 2, price: 3 }, description: 'Поле → номер колонки (с 0). Атрибуты: "attr:sae"' })
  @IsObject()
  mapping: Record<string, number>;
  @ApiPropertyOptional({ type: ImportOptionsDto }) @IsOptional() @ValidateNested() @Type(() => ImportOptionsDto) options?: ImportOptionsDto;
}

@ApiTags('Импорт')
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get()
  @RequirePermission('products.import')
  list() {
    return this.imports.list();
  }

  @Get('templates')
  @ApiOperation({ summary: 'Шаблоны перехода с 1С и МойСклад: какую выгрузку сделать, какие колонки распознаются сами' })
  templates() {
    return IMPORT_TEMPLATES;
  }

  @Get('fields/:type')
  @RequirePermission('products.import')
  @ApiOperation({ summary: 'Поля для сопоставления колонок' })
  fields(@Param('type') type: 'products' | 'crosses' | 'applicability') {
    return this.imports.fields(type) ?? [];
  }

  @Post()
  @RequirePermission('products.import')
  @ApiOperation({ summary: '1. Файл загружен → колонки, первые строки и угаданное сопоставление' })
  create(@Body() dto: CreateImportDto) {
    return this.imports.create(dto.type, dto.fileId, dto.headerRow);
  }

  @Post(':id/preview')
  @HttpCode(200)
  @RequirePermission('products.import')
  @ApiOperation({ summary: '2. Предпросмотр: ошибки по строкам, сколько создастся и обновится' })
  preview(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewImportDto) {
    return this.imports.preview(id, dto.mapping, dto.options);
  }

  @Post(':id/run')
  @HttpCode(202)
  @RequirePermission('products.import')
  @ApiOperation({ summary: '3. Запуск в фоне; прогресс — событие WebSocket import.progress' })
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.run(id);
  }

  @Get(':id')
  @RequirePermission('products.import')
  @ApiOperation({ summary: 'Состояние и ошибки по строкам' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(id);
  }

  @Post(':id/rollback')
  @HttpCode(200)
  @RequirePermission('products.import')
  @ApiOperation({ summary: 'Откатить загрузку целиком (пока по товарам нет документов)' })
  rollback(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.rollback(id);
  }
}

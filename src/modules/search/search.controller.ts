import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { SearchService } from './search.service';
import { SynonymsService } from './synonyms.service';

export class SearchQueryDto {
  @ApiProperty({ example: 'колодки камри 40' }) @IsString() @Length(0, 200) q: string;
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ enum: ['cash', 'catalog', 'document', 'global'] }) @IsOptional() @IsIn(['cash', 'catalog', 'document', 'global']) context?: string;
  @ApiPropertyOptional({ description: 'Записывать ненайденный запрос (по умолчанию да)' })
  @IsOptional()
  @Transform(({ value }) => value !== 'false' && value !== false && value !== '0')
  @IsBoolean()
  log?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() generationId?: string;
  @ApiPropertyOptional({ description: 'Машина клиента из карточки — подбор под неё' }) @IsOptional() @IsUUID() customerVehicleId?: string;
  @ApiPropertyOptional({ example: 'JTNBE40K803123456' }) @IsOptional() @IsString() @Length(17, 20) vin?: string;
  @ApiPropertyOptional({ example: 'ACV40-1234567' }) @IsOptional() @IsString() @Length(2, 30) bodyCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modificationId?: string;
  @ApiPropertyOptional({ example: 2008 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1950) @Max(2100) year?: number;
  @ApiPropertyOptional({ enum: ['right', 'left'] }) @IsOptional() @IsIn(['right', 'left']) steering?: 'right' | 'left';
  @ApiPropertyOptional({ enum: ['Левая', 'Правая'] }) @IsOptional() @IsIn(['Левая', 'Правая']) side?: string;
  @ApiPropertyOptional({ enum: ['Передняя', 'Задняя'] }) @IsOptional() @IsIn(['Передняя', 'Задняя']) axle?: string;
}

export class SynonymDto {
  @ApiProperty({ example: 'бочонок' }) @IsString() @Length(1, 100) word: string;
  @ApiProperty({ example: 'глушитель' }) @IsString() @Length(1, 200) target: string;
}

export class UnfoundQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

@ApiTags('Поиск')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly synonyms: SynonymsService,
  ) {}

  @Get()
  @RequirePermission('products.read')
  @ApiOperation({
    summary: 'Единый поиск: номер в любом формате, артикул, штрихкод, название, сленг, транслит, раскладка, размеры, машина',
  })
  run(@Query() q: SearchQueryDto) {
    return this.search.search(q);
  }

  @Get('unfound')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Отчёт «Что спрашивают, но нет»' })
  unfound(@Query() q: UnfoundQueryDto) {
    return this.search.unfoundReport(q.from, q.to);
  }

  @Get('synonyms')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Словарь синонимов: свой + базовый' })
  listSynonyms() {
    return this.synonyms.list();
  }

  @Post('synonyms')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Добавить «слово → что искать»' })
  addSynonym(@Body() dto: SynonymDto) {
    return this.synonyms.create(dto.word, dto.target);
  }

  @Delete('synonyms/:id')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  async removeSynonym(@Param('id', ParseUUIDPipe) id: string) {
    await this.synonyms.remove(id);
  }
}

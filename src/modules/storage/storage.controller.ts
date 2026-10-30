import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { Response } from 'express';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { StorageService } from './storage.service';

export class LocationDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() version?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional({ example: 'СТ-1' }) @IsOptional() @IsString() @Length(1, 40) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional({ enum: ['zone', 'rack', 'shelf', 'cell'] }) @IsOptional() @IsIn(['zone', 'rack', 'shelf', 'cell']) kind?: any;
  @ApiPropertyOptional({ enum: ['storage', 'pick', 'receiving', 'shipping', 'defect'] }) @IsOptional() @IsIn(['storage', 'pick', 'receiving', 'shipping', 'defect']) cellType?: any;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() capacity?: string;
  @ApiPropertyOptional({ enum: ['small', 'medium', 'large', 'floor'] }) @IsOptional() @IsIn(['small', 'medium', 'large', 'floor']) sizeClass?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() mixed?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() pickPriority?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() walkOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() blocked?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) categoryIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) makeIds?: string[];
}
export class GenerateDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ example: 'S1' }) @IsString() @Length(1, 6) zone: string;
  @ApiProperty({ example: 'A' }) @IsString() @Length(1, 4) row: string;
  @ApiProperty({ example: [1, 20] }) @IsArray() racks: [number, number];
  @ApiProperty({ example: [1, 5] }) @IsArray() shelves: [number, number];
  @ApiProperty({ example: [1, 4] }) @IsArray() cells: [number, number];
  @ApiPropertyOptional() @IsOptional() @IsIn(['storage', 'pick', 'receiving', 'shipping', 'defect']) cellType?: any;
  @ApiPropertyOptional() @IsOptional() @IsString() sizeClass?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() capacity?: string;
}
export class ProductLocationDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() locationId: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isMain?: boolean;
  @ApiPropertyOptional({ description: 'Минимум в ячейке отбора (пополнение)' }) @IsOptional() @IsNumberString() minQty?: string;
}
export class MoveDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsUUID() fromLocationId: string;
  @ApiProperty() @IsUUID() toLocationId: string;
  @ApiProperty() @IsNumberString() qty: string;
}
class PickLine {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsNumberString() qty: string;
}
export class PickDto {
  @ApiProperty() @IsUUID() warehouseId: string;
  @ApiProperty({ type: [PickLine] }) @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PickLine) lines: PickLine[];
  @ApiPropertyOptional() @IsOptional() @IsString() sourceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sourceId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
}
export class DoLineDto {
  @ApiProperty() @IsInt() index: number;
  @ApiPropertyOptional({ description: 'Отсканированная ячейка' }) @IsOptional() @IsUUID() locationId?: string;
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsNumberString() qty: string;
  @ApiPropertyOptional({ description: '«Недостача в ячейке»' }) @IsOptional() @IsBoolean() shortage?: boolean;
}
export class LabelsDto {
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) codes?: string[];
}

@ApiTags('Хранение: места, ячейки, задания')
@Controller('storage')
export class StorageController {
  constructor(private readonly s: StorageService) {}

  @Get('warehouses/:id/locations') @RequirePermission('stock.read') tree(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.tree(id);
  }
  @Post('locations') @RequirePermission('stock.locations') add(@Body() dto: LocationDto) {
    return this.s.saveLocation(null, dto as any);
  }
  @Patch('locations/:id') @RequirePermission('stock.locations') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LocationDto) {
    return this.s.saveLocation(id, dto as any);
  }
  @Get('locations/:id/contents') @RequirePermission('stock.read') contents(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.cellContents(id);
  }
  @Post('locations/generate') @RequirePermission('stock.locations') @ApiOperation({ summary: 'Генератор ячеек S1-A-03-2-05 (склад → уровень 3)' })
  generate(@Body() dto: GenerateDto) {
    return this.s.generate(dto);
  }
  @Post('warehouses/:id/from-text-places') @RequirePermission('stock.locations') @ApiOperation({ summary: 'Уровень 1→2: справочник мест из текстовых мест одной кнопкой' })
  fromText(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.fromTextPlaces(id);
  }
  @Post('warehouses/:id/downgrade') @RequirePermission('stock.locations') @ApiOperation({ summary: 'Уровень 3→2: ячейки остаются справочными местами' })
  downgrade(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.downgrade(id);
  }
  @Post('warehouses/:id/labels') @RequirePermission('stock.labels') async labels(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LabelsDto, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'application/pdf' });
    return new StreamableFile(await this.s.labels(id, dto.codes));
  }
  @Get('warehouses/:id/without-place') @RequirePermission('stock.read') withoutPlace(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.withoutPlace(id);
  }
  @Get('warehouses/:id/misplaced') @RequirePermission('stock.read') @ApiOperation({ summary: 'Возможная пересортица по ячейкам' })
  misplaced(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.misplaced(id);
  }
  @Get('warehouses/:id/workload') @RequirePermission('stock.tasks') workload(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.workload(id);
  }
  @Get('products/:id/locations') @RequirePermission('stock.read') productLocations(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.productLocations(id);
  }
  @Post('product-locations') @RequirePermission('stock.locations') setProductLocation(@Body() dto: ProductLocationDto) {
    return this.s.setProductLocation(dto);
  }
  @Get('suggest') @RequirePermission('stock.read') @ApiOperation({ summary: 'Куда положить товар' })
  suggest(@Query('warehouseId', ParseUUIDPipe) w: string, @Query('productId', ParseUUIDPipe) p: string, @Query('qty') qty?: string) {
    return this.s.suggestFor(w, p, qty);
  }
  @Post('move') @RequirePermission('stock.tasks') @ApiOperation({ summary: 'Перемещение между ячейками (остаток склада не меняется)' })
  move(@Body() dto: MoveDto) {
    return this.s.move(dto);
  }
  @Get('tasks') @RequirePermission('stock.tasks') tasks(@Query('warehouseId') warehouseId?: string, @Query('status') status?: string, @Query('mine') mine?: string) {
    return this.s.tasks({ warehouseId, status, mine: mine === 'true' });
  }
  @Post('tasks/pick') @RequirePermission('stock.tasks') @ApiOperation({ summary: 'Задание на подбор с маршрутом по ячейкам' })
  pick(@Body() dto: PickDto) {
    return this.s.pickTask(dto);
  }
  @Post('tasks/:id/line') @RequirePermission('stock.tasks') @ApiOperation({ summary: 'Скан ячейки и товара, количество; «недостача» — пересчёт и другая ячейка' })
  doLine(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DoLineDto) {
    return this.s.doLine(id, dto);
  }
  @Post('warehouses/:id/replenish') @RequirePermission('stock.tasks') @ApiOperation({ summary: 'Пополнение ячеек отбора ниже минимума' })
  replenish(@Param('id', ParseUUIDPipe) id: string) {
    return this.s.replenish(id);
  }
}

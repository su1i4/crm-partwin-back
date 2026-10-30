import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { BrandsService } from './brands.service';
import { CategoriesService } from './categories.service';
import {
  AttributeDto,
  CreateBrandDto,
  CreateCategoryDto,
  CreatePartTypeDto,
  UpdateAttributeDto,
  UpdateBrandDto,
  UpdateCategoryDto,
  UpdatePartTypeDto,
} from './dto/dictionaries.dto';
import { PartTypesService } from './part-types.service';

@ApiTags('Каталог: справочники')
@Controller()
export class DictionariesController {
  constructor(
    private readonly brands: BrandsService,
    private readonly categories: CategoriesService,
    private readonly partTypes: PartTypesService,
  ) {}

  // Бренды
  @Get('brands')
  @RequirePermission('products.read')
  @ApiQuery({ name: 'q', required: false })
  @ApiOperation({ summary: 'Бренды: свои + общий справочник (source=global — ещё не подключён)' })
  listBrands(@Query('q') q?: string) {
    return this.brands.list(q);
  }

  @Post('brands')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Свой бренд или подключить глобальный' })
  createBrand(@Body() dto: CreateBrandDto) {
    return this.brands.create(dto);
  }

  @Patch('brands/:id')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Изменить бренд и синонимы' })
  updateBrand(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBrandDto) {
    return this.brands.update(id, dto);
  }

  @Delete('brands/:id')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeBrand(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.brands.remove(id, version);
  }

  // Категории
  @Get('categories')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Дерево категорий (плоский список с parentId, path, level) и число товаров' })
  listCategories() {
    return this.categories.list();
  }

  @Post('categories')
  @RequirePermission('catalog.manage')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch('categories/:id')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Переименовать, перенести, изменить правила (гарантия, возврат, «парой»…)' })
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeCategory(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.categories.remove(id, version);
  }

  // Типы деталей и атрибуты
  @Get('part-types')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Типы деталей с атрибутами + общие атрибуты' })
  listTypes() {
    return this.partTypes.list();
  }

  @Post('part-types')
  @RequirePermission('catalog.manage')
  createType(@Body() dto: CreatePartTypeDto) {
    return this.partTypes.createType(dto);
  }

  @Patch('part-types/:id')
  @RequirePermission('catalog.manage')
  updateType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePartTypeDto) {
    return this.partTypes.updateType(id, dto);
  }

  @Delete('part-types/:id')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeType(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.partTypes.removeType(id, version);
  }

  @Post('part-types/:id/attributes')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Добавить атрибут типу детали' })
  createAttr(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AttributeDto) {
    return this.partTypes.createAttribute(id, dto);
  }

  @Post('attributes')
  @RequirePermission('catalog.manage')
  @ApiOperation({ summary: 'Добавить атрибут для всех деталей' })
  createCommonAttr(@Body() dto: AttributeDto) {
    return this.partTypes.createAttribute(null, dto);
  }

  @Patch('attributes/:id')
  @RequirePermission('catalog.manage')
  updateAttr(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAttributeDto) {
    return this.partTypes.updateAttribute(id, dto);
  }

  @Delete('attributes/:id')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  @ApiQuery({ name: 'version', type: Number })
  async removeAttr(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.partTypes.removeAttribute(id, version);
  }
}

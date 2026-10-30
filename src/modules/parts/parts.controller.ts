import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { CrossesService } from './crosses.service';
import { CreateCrossDto } from './dto/cross.dto';

@ApiTags('Каталог: аналоги')
@Controller()
export class PartsController {
  constructor(private readonly crosses: CrossesService) {}

  @Get('products/:id/analogs')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Аналоги товара на 2 уровня (уровень 2 — «через аналог»)' })
  analogs(@Param('id', ParseUUIDPipe) id: string) {
    return this.crosses.analogs(id);
  }

  @Get('products/:id/crosses')
  @RequirePermission('products.read')
  @ApiOperation({ summary: 'Кроссы по номерам товара' })
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.crosses.listForProduct(id);
  }

  @Post('crosses')
  @RequirePermission('products.write')
  @ApiOperation({ summary: 'Добавить кросс «номер ↔ номер»' })
  create(@Body() dto: CreateCrossDto) {
    return this.crosses.add(dto);
  }

  @Delete('crosses/:id')
  @HttpCode(204)
  @RequirePermission('products.write')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.crosses.remove(id);
  }
}

import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Response } from 'express';
import { RequestContext } from '../../common/context/request-context';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { Errors } from '../../common/errors/app.exception';
import { DashboardService } from './dashboard.service';
import { ReportsService } from './reports.service';
import { SummaryService } from './summary.service';

export class ReportQuery {
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ description: 'Остатки на дату' }) @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() brandId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 20) qualityClass?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() makeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() modelId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() sellerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ description: 'Группировка — варианты в каталоге отчётов' }) @IsOptional() @IsString() @Length(1, 20) groupBy?: string;
  @ApiPropertyOptional({ description: 'N дней (залежалые, давно не покупали, календарь)' })
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(3650) days?: number;
  @ApiPropertyOptional({ default: 500 }) @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(5000) limit?: number;
}

export class ViewDto {
  @ApiProperty({ example: 'sales.by' }) @IsString() @Length(1, 60) report: string;
  @ApiProperty({ example: 'Продажи по брендам за месяц' }) @IsString() @Length(1, 100) name: string;
  @ApiProperty({ example: { groupBy: 'brand' } }) @IsObject() params: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'Видят все (только владелец)' }) @IsOptional() @IsBoolean() shared?: boolean;
}

export class RebuildDto {
  @ApiProperty() @IsDateString() from: string;
  @ApiProperty() @IsDateString() to: string;
}

export class DashboardQuery {
  @ApiPropertyOptional({ enum: ['today', 'week', 'month'] }) @IsOptional() @IsIn(['today', 'week', 'month']) period?: 'today' | 'week' | 'month';
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

@ApiTags('Отчёты и дашборд')
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly dashboard: DashboardService,
    private readonly summary: SummaryService,
    private readonly ctx: RequestContext,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Дашборд: блоки по правам (продавец — смена и заявки, кладовщик — приёмки, владелец — деньги)' })
  get(@Query() q: DashboardQuery) {
    return this.dashboard.get(q);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Каталог отчётов, доступных пользователю, по группам' })
  catalog() {
    return this.reports.catalog();
  }

  @Get('reports/views')
  views(@Query('report') report?: string) {
    return this.reports.views(report);
  }

  @Post('reports/views')
  saveView(@Body() dto: ViewDto) {
    return this.reports.saveView(dto);
  }

  @Delete('reports/views/:id')
  deleteView(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.deleteView(id);
  }

  @Post('reports/rebuild')
  @ApiOperation({ summary: 'Пересчитать отчётную таблицу продаж за период (обычно — по событиям и ночью)' })
  rebuild(@Body() dto: RebuildDto) {
    return this.reports.rebuild(dto.from, dto.to);
  }

  @Get('reports/summary/preview')
  @RequirePermission('dashboard.owner')
  @ApiOperation({ summary: 'Вечерняя сводка владельцу — как выглядит сейчас' })
  preview() {
    return this.summary.preview();
  }

  @Post('reports/summary/send')
  @RequirePermission('dashboard.owner')
  @ApiOperation({ summary: 'Отправить вечернюю сводку сейчас (обычно — сама в настроенное время)' })
  sendSummary() {
    if (!this.ctx.isOwner) throw Errors.forbidden('Только владелец');
    return this.summary.sendNow();
  }

  @Get('reports/summary/history')
  @RequirePermission('dashboard.owner')
  history() {
    return this.summary.history();
  }

  @Get('reports/:code/xlsx')
  @RequireAnyPermission('reports.export')
  async xlsx(@Param('code') code: string, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    const f = await this.reports.xlsx(code, q);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${f.name}"` });
    return new StreamableFile(f.buffer);
  }

  @Get('reports/:code/pdf')
  @RequireAnyPermission('reports.export')
  async pdf(@Param('code') code: string, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    const f = await this.reports.pdfFile(code, q);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${f.name}"` });
    return new StreamableFile(f.buffer);
  }

  @Get('reports/:code')
  @ApiOperation({ summary: 'Отчёт: колонки, строки, итоги. Права — по отчёту' })
  run(@Param('code') code: string, @Query() q: ReportQuery) {
    return this.reports.run(code, q);
  }
}

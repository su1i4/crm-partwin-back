import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumberString, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { RequestContext } from '../../common/context/request-context';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { Errors } from '../../common/errors/app.exception';
import { ExpensesService } from './expenses.service';
import { FxService } from './fx.service';

export class ExpenseDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() articleId?: string;
  @ApiPropertyOptional({ example: 'rent', description: 'Код статьи вместо id: rent, salary, utilities, delivery, ads, bank_fee, other, owner' })
  @IsOptional() @IsString() @Length(1, 40) articleCode?: string;
  @ApiProperty() @IsUUID() accountId: string;
  @ApiProperty({ example: '25000' }) @IsNumberString() amount: string;
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional({ description: 'Зарплата: кому' }) @IsOptional() @IsUUID() membershipId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}

export class ExpensesQuery extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() articleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: ['expense', 'salary', 'owner'] }) @IsOptional() @IsIn(['expense', 'salary', 'owner']) kind?: string;
}

export class ArticleDto {
  @ApiProperty({ example: 'Охрана' }) @IsString() @Length(1, 100) name: string;
  @ApiPropertyOptional({ enum: ['expense', 'salary'] }) @IsOptional() @IsIn(['expense', 'salary']) kind?: 'expense' | 'salary';
}

export class ArticleUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CancelDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) reason?: string;
}

export class RecurringDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() articleId?: string;
  @ApiPropertyOptional({ example: 'rent' }) @IsOptional() @IsString() articleCode?: string;
  @ApiProperty() @IsUUID() accountId: string;
  @ApiProperty({ example: '30000' }) @IsNumberString() amount: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(31) dayOfMonth: number;
  @ApiPropertyOptional({ description: 'С какой даты (по умолчанию — сегодня)' }) @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) comment?: string;
}

export class RecurringUpdateDto {
  @ApiProperty() @IsInt() version: number;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() amount?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(31) dayOfMonth?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 300) comment?: string;
}

export class RunRecurringDto {
  @ApiPropertyOptional({ description: 'Провести как будто сегодня эта дата (проверка расписания)' }) @IsOptional() @IsDateString() today?: string;
}

export class SalaryRuleDto {
  @ApiPropertyOptional({ example: '15000' }) @IsOptional() @IsNumberString() baseMonthly?: string;
  @ApiPropertyOptional({ example: '3' }) @IsOptional() @IsNumberString() percent?: string;
  @ApiPropertyOptional({ enum: ['sales', 'margin'] }) @IsOptional() @IsIn(['sales', 'margin']) basis?: 'sales' | 'margin';
  @ApiPropertyOptional({ example: '500000' }) @IsOptional() @IsNumberString() planMonthly?: string;
}

export class RatesQuery {
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}

export class MonthDto {
  @ApiProperty({ example: '2026-09' }) @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month: string;
}

@ApiTags('Деньги: расходы, курсы НБКР, мотивация')
@Controller('money')
export class MoneyExtraController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly fx: FxService,
    private readonly ctx: RequestContext,
  ) {}

  @Get('expense-articles')
  @RequirePermission('money.read')
  articles() {
    return this.expenses.articles();
  }

  @Post('expense-articles')
  @RequirePermission('money.write')
  createArticle(@Body() dto: ArticleDto) {
    return this.expenses.createArticle(dto);
  }

  @Patch('expense-articles/:id')
  @RequirePermission('money.write')
  updateArticle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ArticleUpdateDto) {
    return this.expenses.updateArticle(id, dto);
  }

  @Get('expenses')
  @RequirePermission('money.read')
  list(@Query() q: ExpensesQuery) {
    return this.expenses.list(q);
  }

  @Post('expenses')
  @RequirePermission('money.write')
  @ApiOperation({ summary: 'Расход по статье или изъятие собственника (статья owner — не расход, в прибыль не входит)' })
  create(@Body() dto: ExpenseDto) {
    return this.expenses.create(dto);
  }

  @Post('expenses/:id/cancel')
  @RequirePermission('money.write')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.expenses.cancel(id, dto.reason);
  }

  @Get('recurring-expenses')
  @RequirePermission('money.read')
  recurring() {
    return this.expenses.listRecurring();
  }

  @Post('recurring-expenses')
  @RequirePermission('money.write')
  @ApiOperation({ summary: 'Регулярный расход: каждое N-е число месяца проводится сам' })
  createRecurring(@Body() dto: RecurringDto) {
    return this.expenses.createRecurring(dto);
  }

  @Patch('recurring-expenses/:id')
  @RequirePermission('money.write')
  updateRecurring(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecurringUpdateDto) {
    const { version, ...rest } = dto;
    return this.expenses.updateRecurring(id, version, rest);
  }

  @Post('recurring-expenses/run')
  @RequirePermission('money.write')
  @ApiOperation({ summary: 'Провести наступившие регулярные расходы сейчас (обычно — каждое утро само)' })
  runRecurring(@Body() dto: RunRecurringDto) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Только владелец');
    return this.expenses.runRecurring(this.ctx.requireTenantId(), dto.today);
  }

  @Get('salary-rules')
  @RequirePermission('staff.read')
  salaryRules() {
    return this.expenses.salaryRules();
  }

  @Put('salary-rules/:membershipId')
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Мотивация: оклад, % от продаж или маржи, план на месяц' })
  setSalaryRule(@Param('membershipId', ParseUUIDPipe) id: string, @Body() dto: SalaryRuleDto) {
    return this.expenses.setSalaryRule(id, dto);
  }

  @Get('nbkr-rates')
  @RequirePermission('money.read')
  @ApiOperation({ summary: 'Курсы НБКР на дату (последние опубликованные)' })
  rates(@Query() q: RatesQuery) {
    return this.fx.ratesOn(q.date);
  }

  @Post('nbkr-rates/refresh')
  @RequirePermission('money.write')
  @ApiOperation({ summary: 'Загрузить курсы НБКР сейчас (обычно — каждый день само)' })
  refresh() {
    return this.fx.load();
  }

  @Post('revaluation')
  @RequirePermission('money.write')
  @ApiOperation({ summary: 'Переоценка валютных долгов за месяц по курсу НБКР (1-го числа — само за прошлый месяц)' })
  revalue(@Body() dto: MonthDto) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Только владелец');
    return this.fx.revalue(dto.month);
  }
}

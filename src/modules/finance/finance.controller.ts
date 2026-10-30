import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { VersionDto } from '../../common/dto/version.dto';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { DebtsService } from './debts.service';
import { MONEY_ACCOUNT_TYPES, MoneyAccountType } from './entities/money-account.entity';
import { MoneyService } from './money.service';
import { ShiftsService } from './shifts.service';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

class AccountDto {
  @ApiPropertyOptional({ enum: MONEY_ACCOUNT_TYPES }) @IsOptional() @IsIn(MONEY_ACCOUNT_TYPES) type?: MoneyAccountType;
  @ApiPropertyOptional({ example: 'MBank — Азамат — 0555123456' }) @IsOptional() @IsString() @Length(1, 200) name?: string;
  @ApiPropertyOptional({ example: 'KGS' }) @IsOptional() @IsIn(['KGS', 'USD', 'CNY', 'RUB', 'EUR', 'KZT']) currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string | null;
  @ApiPropertyOptional({ description: 'Чей кошелёк / подотчёт (участник магазина)' }) @IsOptional() @IsUUID() holderMembershipId?: string | null;
  @ApiPropertyOptional({ example: { provider: 'MBank', phone: '0555123456', commissionPercent: '1.5' } }) @IsOptional() @IsObject() details?: Record<string, any>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
class UpdateAccountDto extends AccountDto {
  @ApiProperty() @IsInt() version: number;
}
class AccountsQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ enum: MONEY_ACCOUNT_TYPES }) @IsOptional() @IsIn(MONEY_ACCOUNT_TYPES) type?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() includeInactive?: boolean;
}
class MovementsQuery extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shiftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}
class OperationDto {
  @ApiProperty({ enum: ['cash_in', 'cash_out', 'transfer', 'exchange'] }) @IsIn(['cash_in', 'cash_out', 'transfer', 'exchange']) type: 'cash_in' | 'cash_out' | 'transfer' | 'exchange';
  @ApiPropertyOptional() @IsOptional() @IsUUID() fromAccountId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() toAccountId?: string;
  @ApiProperty({ example: '5000' }) @IsNumberString() amount: string;
  @ApiPropertyOptional({ description: 'Обмен: сколько получили' }) @IsOptional() @IsNumberString() toAmount?: string;
  @ApiPropertyOptional({ description: 'Обмен: фактический курс' }) @IsOptional() @IsNumberString() rate?: string;
  @ApiPropertyOptional({ enum: ['safe', 'owner', 'bank', 'other'] }) @IsOptional() @IsIn(['safe', 'owner', 'bank', 'other']) purpose?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}

class OpenShiftDto {
  @ApiProperty() @IsUUID() registerId: string;
  @ApiProperty({ example: { KGS: '5000', USD: '0' }, description: 'Наличные в кассе по валютам (пересчёт)' }) @IsObject() cash: Record<string, string>;
}
class CloseShiftDto extends VersionDto {
  @ApiProperty({ example: { KGS: '48350', USD: '120' } }) @IsObject() counted: Record<string, string>;
}
class HandoverDto extends VersionDto {
  @ApiProperty() @IsUUID() toMembershipId: string;
  @ApiProperty({ example: { KGS: '23000' } }) @IsObject() counted: Record<string, string>;
}
class ShiftCashDto {
  @ApiProperty({ enum: ['cash_in', 'cash_out', 'exchange'] }) @IsIn(['cash_in', 'cash_out', 'exchange']) type: 'cash_in' | 'cash_out' | 'exchange';
  @ApiPropertyOptional({ default: 'KGS', description: 'Валюта наличных (обмен: какую валюту отдаём)' }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
  @ApiProperty({ example: '10000' }) @IsNumberString() amount: string;
  @ApiPropertyOptional({ description: 'Изъятие: на какой счёт (сейф, банк); внесение — откуда' }) @IsOptional() @IsUUID() toAccountId?: string;
  @ApiPropertyOptional({ enum: ['safe', 'owner', 'bank', 'other'] }) @IsOptional() @IsIn(['safe', 'owner', 'bank', 'other']) purpose?: string;
  @ApiPropertyOptional({ example: '87.10' }) @IsOptional() @IsNumberString() rate?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() toAmount?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
}
class ShiftsQuery extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() registerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() storeId?: string;
}

class DebtsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['receivable', 'payable'] }) @IsOptional() @IsIn(['receivable', 'payable']) direction?: 'receivable' | 'payable';
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() overdueOnly?: boolean;
}
class DebtItemsQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
  @ApiPropertyOptional({ enum: ['receivable', 'payable'] }) @IsOptional() @IsIn(['receivable', 'payable']) direction?: 'receivable' | 'payable';
  @ApiPropertyOptional({ default: true }) @IsOptional() @Transform(toBool) @IsBoolean() open?: boolean;
}
class AllocationDto {
  @ApiProperty({ enum: ['oldest', 'vehicles', 'items'] }) @IsIn(['oldest', 'vehicles', 'items']) mode: 'oldest' | 'vehicles' | 'items';
  @ApiPropertyOptional({ type: [String], description: 'null в списке — «без машины»' }) @IsOptional() @IsArray() vehicleIds?: (string | null)[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsUUID('4', { each: true }) itemIds?: string[];
}
class DebtPayDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiProperty({ enum: ['in', 'out'], description: 'in — клиент платит; out — мы платим соседу/поставщику' }) @IsIn(['in', 'out']) direction: 'in' | 'out';
  @ApiPropertyOptional({ default: 'KGS', description: 'Валюта долга' }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
  @ApiProperty({ example: '15000' }) @IsNumberString() amount: string;
  @ApiProperty({ description: 'Счёт, куда пришли / откуда ушли деньги' }) @IsUUID() accountId: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() accountAmount?: string;
  @ApiPropertyOptional({ type: AllocationDto }) @IsOptional() @ValidateNested() @Type(() => AllocationDto) allocation?: AllocationDto;
  @ApiPropertyOptional() @IsOptional() @IsUUID() shiftId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 500) comment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(8, 64) idempotencyKey?: string;
}
class OffsetDto {
  @ApiProperty() @IsUUID() counterpartyId: string;
  @ApiPropertyOptional({ default: 'KGS' }) @IsOptional() @IsIn(['KGS', 'USD']) currency?: string;
}
class StatementQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() vehicleId?: string;
}

@ApiTags('Деньги, смены, долги')
@Controller()
export class FinanceController {
  constructor(
    private readonly money: MoneyService,
    private readonly shifts: ShiftsService,
    private readonly debts: DebtsService,
    private readonly tenantTx: TenantTransaction,
  ) {}

  // ── Счета и движения ─────────────────────────────────────

  @Get('money/accounts')
  @RequireAnyPermission('money.read', 'pos.use')
  @ApiOperation({ summary: 'Счета: кассы, сейф, кошельки, эквайринг, банк, подотчёт (остатки — с правом money.read)' })
  accounts(@Query() q: AccountsQuery) {
    return this.money.accounts(q);
  }

  @Post('money/accounts')
  @RequirePermission('settings.manage')
  createAccount(@Body() dto: AccountDto) {
    return this.money.createAccount(dto);
  }

  @Patch('money/accounts/:id')
  @RequirePermission('settings.manage')
  updateAccount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAccountDto) {
    return this.money.updateAccount(id, dto.version, dto);
  }

  @Get('money/movements')
  @RequirePermission('money.read')
  movements(@Query() q: MovementsQuery) {
    return this.money.movements(q);
  }

  @Post('money/operations')
  @RequirePermission('money.write')
  @ApiOperation({ summary: 'Перемещение денег (касса → сейф, сдал владельцу), обмен, внесение и изъятие вне смены' })
  operation(@Body() dto: OperationDto) {
    return this.tenantTx.run((tx) => this.money.operation(tx, dto));
  }

  // ── Смены ────────────────────────────────────────────────

  @Get('shifts/current')
  @RequireAnyPermission('pos.use', 'pos.shift')
  @ApiOperation({ summary: 'Открытая смена кассы и наличные' })
  current(@Query('registerId', ParseUUIDPipe) registerId: string) {
    return this.shifts.current(registerId);
  }

  @Get('shifts')
  @RequireAnyPermission('pos.shift', 'money.read')
  list(@Query() q: ShiftsQuery) {
    return this.shifts.list(q);
  }

  @Post('shifts/open')
  @RequirePermission('pos.shift')
  @ApiOperation({ summary: 'Открыть смену: наличные по валютам; расхождение с остатком — в отчёт' })
  open(@Body() dto: OpenShiftDto) {
    return this.shifts.open(dto.registerId, dto.cash);
  }

  @Get('shifts/:id/x-report')
  @RequireAnyPermission('pos.shift', 'money.read')
  @ApiOperation({ summary: 'X-отчёт (в любой момент); для закрытой смены — Z-отчёт' })
  xReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.xReport(id);
  }

  @Post('shifts/:id/cash')
  @RequirePermission('pos.cash_in_out')
  @ApiOperation({ summary: 'Внесение, изъятие (куда: сейф, владельцу, банк), обмен валюты в кассе' })
  cash(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ShiftCashDto) {
    return this.shifts.cashOperation(id, dto);
  }

  @Post('shifts/:id/handover')
  @RequirePermission('pos.shift')
  @ApiOperation({ summary: 'Передача кассы другому продавцу с пересчётом (если включено в настройках)' })
  handover(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HandoverDto) {
    return this.shifts.handover(id, dto.version, dto.toMembershipId, dto.counted);
  }

  @Post('shifts/:id/close')
  @RequirePermission('pos.shift')
  @ApiOperation({ summary: 'Закрыть смену: фактические наличные → расхождение → Z-отчёт' })
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseShiftDto) {
    return this.shifts.close(id, dto.version, dto.counted);
  }

  // ── Долги ────────────────────────────────────────────────

  @Get('debts')
  @RequirePermission('customers.debts')
  @ApiOperation({ summary: 'Дебиторка / кредиторка с возрастом долга (0–30, 31–60, 61–90, 90+)' })
  debtsList(@Query() q: DebtsQuery) {
    return this.debts.list(q);
  }

  @Get('counterparties/:id/debts')
  @RequireAnyPermission('customers.debts', 'pos.use')
  @ApiOperation({ summary: 'Позиции долга; фильтр «за какую машину»' })
  items(@Param('id', ParseUUIDPipe) id: string, @Query() q: DebtItemsQuery) {
    return this.debts.items(id, q);
  }

  @Get('counterparties/:id/debts/statement')
  @RequireAnyPermission('customers.debts', 'pos.use')
  @ApiOperation({ summary: 'Сверка одним сообщением: текст «дата — машина — что — сумма», ссылки WhatsApp и Telegram' })
  statement(@Param('id', ParseUUIDPipe) id: string, @Query() q: StatementQuery) {
    return this.debts.statement(id, q);
  }

  @Get('counterparties/:id/debts/statement.pdf')
  @RequireAnyPermission('customers.debts', 'pos.use')
  @Header('Content-Type', 'application/pdf')
  async statementPdf(@Param('id', ParseUUIDPipe) id: string, @Query() q: StatementQuery, @Res({ passthrough: true }) res: Response) {
    const buf = await this.debts.statementPdf(id, q);
    res.setHeader('Content-Disposition', 'inline; filename="statement.pdf"');
    return new StreamableFile(buf);
  }

  @Post('debts/payments')
  @RequireAnyPermission('customers.debts', 'pos.use')
  @ApiOperation({ summary: 'Оплата долга: по выбранным машинам, позициям или «сначала старые»; переплата — аванс' })
  pay(@Body() dto: DebtPayDto) {
    return this.debts.pay(dto);
  }

  @Post('debts/offset')
  @RequirePermission('customers.debts')
  @ApiOperation({ summary: 'Взаимозачёт: клиент одновременно сосед/поставщик' })
  offset(@Body() dto: OffsetDto) {
    return this.debts.offset(dto.counterpartyId, dto.currency ?? 'KGS');
  }
}


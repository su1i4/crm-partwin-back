import { Global, Module } from '@nestjs/common';
import { DebtsService } from './debts.service';
import { ExpensesService } from './expenses.service';
import { FxService } from './fx.service';
import { MoneyExtraController } from './money-extra.controller';
import { FinanceController } from './finance.controller';
import { MoneyService } from './money.service';
import { ShiftsService } from './shifts.service';

/** Деньги (ТЗ 19): счета и регистр движений, смены (13.7), долги и взаиморасчёты (18.2, 19.5). */
@Global()
@Module({
  controllers: [FinanceController, MoneyExtraController],
  providers: [MoneyService, ShiftsService, DebtsService, ExpensesService, FxService],
  exports: [MoneyService, ShiftsService, DebtsService, ExpensesService, FxService],
})
export class FinanceModule {}

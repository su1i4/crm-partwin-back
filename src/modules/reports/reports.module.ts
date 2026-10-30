import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { RptSalesService } from './rpt-sales.service';
import { SummaryService } from './summary.service';

/** Отчёты, дашборд, вечерняя сводка (ТЗ 20). */
@Module({ controllers: [ReportsController], providers: [ReportsService, DashboardService, RptSalesService, SummaryService], exports: [RptSalesService] })
export class ReportsModule {}

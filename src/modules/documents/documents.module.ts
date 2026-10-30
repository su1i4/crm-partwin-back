import { Global, Module } from '@nestjs/common';
import { CostRecalcService } from '../inventory/cost-recalc.service';
import { InventoryCountService } from '../inventory/inventory-count.service';
import { PeriodCloseService } from '../inventory/period-close.service';
import { PeriodsService } from '../inventory/periods.service';
import { PlacesService } from '../inventory/places.service';
import { StockControlService } from '../inventory/stock-control.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { StockMaintenanceService } from '../inventory/stock-maintenance.service';
import { StockQueryService } from '../inventory/stock-query.service';
import { InventoriesController, PeriodsController, StockController } from '../inventory/stock.controller';
import { LabelsService } from '../printing/labels.service';
import { PdfService } from '../printing/pdf.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import {
  CostAdjustmentHandler,
  InitialStockHandler,
  InventoryHandler,
  ReceivingHandler,
  ResortHandler,
  SurplusHandler,
  TransferHandler,
  WriteoffHandler,
  SelectionIssueHandler,
  SelectionReturnHandler,
  ConsignmentHandler,
  ConsignmentReturnHandler,
  CustomerPurchaseHandler,
  DonorHandler,
} from './handlers/stock-handlers';
import { SaleHandler, SaleReturnHandler } from './handlers/sale-handlers';
import { ExtraCostsHandler, SupplierReturnHandler } from './handlers/purchase-handlers';
import { DocumentHooks } from './document-hooks';
import { NumberingService } from './numbering.service';
import { TransfersService } from './transfers.service';

/** Склад и документы (этап 2): движок документов, регистры, себестоимость, инвентаризация, периоды, печать этикеток. */
@Global()
@Module({
  controllers: [DocumentsController, StockController, InventoriesController, PeriodsController],
  providers: [
    DocumentsService,
    NumberingService,
    TransfersService,
    StockLedgerService,
    CostRecalcService,
    PeriodsService,
    PeriodCloseService,
    PlacesService,
    StockQueryService,
    StockMaintenanceService,
    StockControlService,
    InventoryCountService,
    PdfService,
    LabelsService,
    InitialStockHandler,
    ReceivingHandler,
    SurplusHandler,
    WriteoffHandler,
    ResortHandler,
    TransferHandler,
    InventoryHandler,
    CostAdjustmentHandler,
    SaleHandler,
    SaleReturnHandler,
    SupplierReturnHandler,
    ExtraCostsHandler,
    SelectionIssueHandler,
    SelectionReturnHandler,
    ConsignmentHandler,
    ConsignmentReturnHandler,
    CustomerPurchaseHandler,
    DonorHandler,
    DocumentHooks,
  ],
  exports: [DocumentHooks, NumberingService, DocumentsService, StockLedgerService, PeriodsService, PdfService, LabelsService, PlacesService, CostRecalcService],
})
export class DocumentsModule {}

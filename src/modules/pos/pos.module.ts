import { Global, Module } from '@nestjs/common';
import { PinService } from './pin.service';
import { PosController, PublicReceiptController, TransfersController, WarrantyController } from './pos.controller';
import { ReceiptPrintService } from './receipt-print.service';
import { ReceiptsService } from './receipts.service';
import { ReturnsService } from './returns.service';
import { TransfersCheckService } from './transfers-check.service';
import { WarrantyService } from './warranty.service';

/** Касса и продажи (этап 3): чек, оплаты, PIN, возвраты, обмен, гарантия, сверка переводов, электронный чек. */
@Global()
@Module({
  controllers: [PosController, WarrantyController, TransfersController, PublicReceiptController],
  providers: [ReceiptsService, ReturnsService, PinService, ReceiptPrintService, WarrantyService, TransfersCheckService],
  exports: [ReceiptsService, ReturnsService, PinService],
})
export class PosModule {}

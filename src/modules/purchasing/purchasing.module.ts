import { Global, Module } from '@nestjs/common';
import { AutoOrderService } from './auto-order.service';
import { PriceListsService } from './price-lists.service';
import { PriceListsController, PurchaseOrdersController, RequestsController } from './purchasing.controller';
import { PurchasingHooksService } from './purchasing-hooks.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ReceivingsService } from './receivings.service';
import { RequestsService } from './requests.service';

/** Закупки и заявки (этап 4): прайсы поставщиков, заказы и автозаказ, полная приёмка, заявки клиентов, лист ожидания. */
@Global()
@Module({
  controllers: [PriceListsController, PurchaseOrdersController, RequestsController],
  providers: [PriceListsService, PurchaseOrdersService, AutoOrderService, PurchasingHooksService, ReceivingsService, RequestsService],
  exports: [PriceListsService, PurchaseOrdersService],
})
export class PurchasingModule {}

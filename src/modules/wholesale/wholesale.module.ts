import { Module } from '@nestjs/common';
import { WholesaleController } from './wholesale.controller';
import { WholesaleService } from './wholesale.service';

/** Опт и большой склад (этап 9): контейнеры, заказы покупателей, доставка, реализация, доноры. */
@Module({ controllers: [WholesaleController], providers: [WholesaleService], exports: [WholesaleService] })
export class WholesaleModule {}

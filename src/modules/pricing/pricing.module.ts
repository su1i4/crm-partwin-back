import { Global, Module } from '@nestjs/common';
import { PriceResolverService } from './price-resolver.service';
import { PricesService } from './prices.service';
import { PricingAdminService } from './pricing-admin.service';
import { PricingController } from './pricing.controller';

/** Цены (ТЗ 17): хранение, движок цен, курс магазина, наценки, установка цен. */
@Global()
@Module({
  controllers: [PricingController],
  providers: [PricesService, PriceResolverService, PricingAdminService],
  exports: [PricesService, PriceResolverService],
})
export class PricingModule {}

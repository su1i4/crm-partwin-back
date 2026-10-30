import { Global, Module } from '@nestjs/common';
import { CountersService } from '../../database/tenant/counters.service';
import { StockProbeService } from '../inventory/stock-probe.service';
import { BrandsService } from './brands.service';
import { CatalogOpsService } from './catalog-ops.service';
import { CatalogPresetsService } from './catalog-presets.service';
import { CategoriesService } from './categories.service';
import { DictionariesController } from './dictionaries.controller';
import { PartTypesService } from './part-types.service';
import { ProductsQueryService } from './products-query.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { SearchTextService } from './search-text.service';

@Global()
@Module({
  controllers: [DictionariesController, ProductsController],
  providers: [
    CatalogPresetsService,
    BrandsService,
    CategoriesService,
    PartTypesService,
    ProductsService,
    ProductsQueryService,
    CatalogOpsService,
    SearchTextService,
    CountersService,
    StockProbeService,
  ],
  exports: [
    CatalogPresetsService,
    BrandsService,
    CategoriesService,
    PartTypesService,
    ProductsService,
    ProductsQueryService,
    SearchTextService,
    CountersService,
    StockProbeService,
  ],
})
export class CatalogModule {}

import { Global, Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SynonymsService } from './synonyms.service';

@Global()
@Module({ controllers: [SearchController], providers: [SearchService, SynonymsService], exports: [SearchService, SynonymsService] })
export class SearchModule {}

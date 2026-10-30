import { Global, Module } from '@nestjs/common';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesService } from './counterparties.service';

@Global()
@Module({ controllers: [CounterpartiesController], providers: [CounterpartiesService], exports: [CounterpartiesService] })
export class CounterpartiesModule {}

import { Module } from '@nestjs/common';
import { StoController } from './sto.controller';
import { StoService } from './sto.service';

/** СТО и мастера, персональные цены, оптовый прайс, покупка у клиента, задачи, шаблоны (этап 8). */
@Module({ controllers: [StoController], providers: [StoService] })
export class StoModule {}

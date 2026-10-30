import { Global, Module } from '@nestjs/common';
import { AgentGateway } from './agent.gateway';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/** Оборудование (ТЗ 12): локальный агент, привязка, задания печати. */
@Global()
@Module({ controllers: [DevicesController], providers: [DevicesService, AgentGateway], exports: [DevicesService] })
export class DevicesModule {}

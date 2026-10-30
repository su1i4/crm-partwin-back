import { Global, Module } from '@nestjs/common';
import { CustomerBotService } from './customer-bot.service';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

/** Акции, промокоды, карты и бонусы, клиентская часть Telegram-бота (ТЗ 17.6–17.7, 22.2). */
@Global()
@Module({ controllers: [LoyaltyController], providers: [LoyaltyService, CustomerBotService], exports: [LoyaltyService, CustomerBotService] })
export class LoyaltyModule {}

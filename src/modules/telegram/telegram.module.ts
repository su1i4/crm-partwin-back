import { Global, Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

/** Telegram-бот платформы (ТЗ 22.2). */
@Global()
@Module({ controllers: [TelegramController], providers: [TelegramService], exports: [TelegramService] })
export class TelegramModule {}

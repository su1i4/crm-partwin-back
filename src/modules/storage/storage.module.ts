import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/** Хранение уровней 2 и 3 (ТЗ 8). */
@Module({ controllers: [StorageController], providers: [StorageService], exports: [StorageService] })
export class StorageModule {}

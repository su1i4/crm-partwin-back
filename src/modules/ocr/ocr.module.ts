import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { OcrController } from './ocr.controller';
import { HttpOcrProvider } from './ocr.provider';
import { OcrService } from './ocr.service';

@Module({ imports: [SearchModule], controllers: [OcrController], providers: [OcrService, HttpOcrProvider] })
export class OcrModule {}

import { Injectable, Logger } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app.config';

export interface OcrLine {
  text: string;
  score?: number;
}

/** Движок распознавания: сейчас — свой ocr-service (PaddleOCR), позже можно подменить облачным. */
export interface OcrProvider {
  readonly name: string;
  recognize(image: Buffer, mime: string): Promise<OcrLine[]>;
}

export const ocrUnavailable = (why: string) =>
  new AppException('OCR_UNAVAILABLE', 'Распознавание фото сейчас недоступно — введите номер вручную', HttpStatus.SERVICE_UNAVAILABLE, { why });

/** HTTP-клиент ocr-service: POST {OCR_URL} (multipart, поле file) → { lines: [{ text, score }] }. */
@Injectable()
export class HttpOcrProvider implements OcrProvider {
  readonly name = 'paddle-http';
  private readonly log = new Logger('OCR');

  constructor(private readonly config: AppConfig) {}

  get enabled() {
    return !!this.config.ocrUrl;
  }

  async recognize(image: Buffer, mime: string): Promise<OcrLine[]> {
    const url = this.config.ocrUrl;
    if (!url) throw ocrUnavailable('OCR_URL не задан');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: mime }), 'photo');
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(this.config.ocrTimeoutMs) });
    } catch (e) {
      this.log.warn(`ocr-service недоступен: ${(e as Error).message}`);
      throw ocrUnavailable('нет связи с ocr-service');
    }
    if (!res.ok) throw ocrUnavailable(`ocr-service ответил ${res.status}`);
    const body: any = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.lines)) throw ocrUnavailable('неверный ответ ocr-service');
    return body.lines
      .filter((l: any) => l && typeof l.text === 'string')
      .slice(0, 200)
      .map((l: any) => ({ text: String(l.text).slice(0, 200), score: typeof l.score === 'number' ? Math.round(l.score * 1000) / 1000 : undefined }));
  }
}

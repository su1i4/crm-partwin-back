import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { FilesService } from '../files/files.service';
import { SearchService } from '../search/search.service';
import { OcrRecognition } from './entities/ocr.entity';
import { extractCandidates } from './ocr-candidates';
import { HttpOcrProvider, ocrUnavailable } from './ocr.provider';

const EXACT_KINDS = ['barcode', 'sku', 'number', 'number_confusable', 'number_prefix', 'number_fuzzy'];

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream as any) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * Распознавание номера с фото (ТЗ 11.3): фото → строки OCR → кандидаты → поиск по каждому.
 * Нашли — товары и поставщики; не нашли — «Создать товар» с номером и «Заявка клиента» с фото.
 */
@Injectable()
export class OcrService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly files: FilesService,
    private readonly search: SearchService,
    private readonly provider: HttpOcrProvider,
  ) {}

  status() {
    return { enabled: this.provider.enabled, provider: this.provider.name };
  }

  async recognize(input: { file?: Express.Multer.File; fileId?: string; context?: string }) {
    const started = Date.now();
    // Без сервиса распознавания фото не сохраняем — сразу 503, касса предложит ввод вручную
    if (!this.provider.enabled) throw ocrUnavailable('OCR_URL не задан');
    let fileId = input.fileId ?? null;
    let image: Buffer;
    let mime: string;
    if (input.file) {
      const f = await this.files.save(input.file, { purpose: 'ocr', entityType: 'ocr' });
      fileId = f.id;
      if (!f.mime.startsWith('image/')) throw Errors.bad('FILE_TYPE', 'Нужно фото (JPEG, PNG, WebP)');
      image = input.file.buffer;
      mime = f.mime;
    } else if (fileId) {
      const { file, stream } = await this.files.open(fileId);
      if (!file.mime.startsWith('image/')) throw Errors.bad('FILE_TYPE', 'Нужно фото (JPEG, PNG, WebP)');
      image = await readAll(stream);
      mime = file.mime;
    } else {
      throw Errors.bad('NO_FILE', 'Передайте фото или fileId');
    }

    const lines = await this.provider.recognize(image, mime);
    const cands = extractCandidates(lines);
    const results: any[] = [];
    for (const c of cands) {
      const r: any = await this.search.search({ q: c.value, limit: 5, log: false, context: 'global' });
      const items = [...r.groups.here, ...r.groups.elsewhere, ...r.groups.noStock].filter((i: any) => EXACT_KINDS.includes(i.matchKind));
      results.push({
        text: c.raw,
        value: c.value,
        kind: c.kind,
        score: c.score,
        found: items.length > 0,
        products: items.slice(0, 5),
        analogs: items.length ? r.groups.analogs.slice(0, 5) : [],
        suppliers: r.groups.suppliers.slice(0, 10),
      });
    }
    const found = results.filter((r) => r.found);
    const best = found[0] ?? results.find((r) => r.suppliers.length) ?? results[0] ?? null;
    const ms = Date.now() - started;
    const log = await this.tenantTx.run((tx) =>
      tx.repo(OcrRecognition).insert({
        fileId,
        provider: this.provider.name,
        lines,
        candidates: results.map((r) => ({ text: r.text, value: r.value, kind: r.kind, score: r.score, found: r.found, productIds: r.products.map((p: any) => p.id) })),
        foundCount: found.length,
        ms,
        context: input.context ?? null,
      }),
    );
    return {
      id: log.id,
      fileId,
      lines,
      candidates: results,
      best: best ? { value: best.value, kind: best.kind, found: best.found } : null,
      /** Ничего не нашли: создать товар с этим номером / заявка клиента с фото */
      actions: found.length
        ? []
        : [
            ...(best ? [{ type: 'create_product', number: best.value }] : []),
            ...(results.some((r) => r.suppliers.length) ? [{ type: 'create_from_pricelist', number: best?.value }] : []),
            { type: 'customer_request', fileId },
            { type: 'manual_input' },
          ],
      tookMs: ms,
    };
  }

  /** Продавец выбрал товар или исправил номер — для статистики качества распознавания. */
  correction(id: string, dto: { correctedText?: string; chosenProductId?: string }) {
    if (!dto.correctedText && !dto.chosenProductId) throw Errors.bad('EMPTY', 'Укажите исправленный номер или выбранный товар');
    return this.tenantTx.run(async (tx) => {
      const repo = tx.repo(OcrRecognition, 'Распознавание');
      const r = await repo.getById(id);
      return repo.save(Object.assign(r, {
        correctedText: dto.correctedText?.trim().slice(0, 80) ?? r.correctedText,
        correctedAt: dto.correctedText ? new Date() : r.correctedAt,
        chosenProductId: dto.chosenProductId ?? r.chosenProductId,
      }));
    });
  }

  /** Качество распознавания: доля найденных с первого раза, исправления (ТЗ 11.3). */
  stats(days = 30) {
    return this.tenantTx.run(async (tx) => {
      const [r] = await tx.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE found_count > 0)::int AS found,
                count(*) FILTER (WHERE corrected_text IS NOT NULL)::int AS corrected,
                coalesce(round(avg(ms))::int, 0) AS "avgMs"
           FROM ocr_recognitions WHERE tenant_id = $1 AND created_at > now() - ($2 || ' days')::interval`,
        [tx.tenantId, String(days)],
      );
      return { days, ...r, foundRate: r.total ? Math.round((r.found / r.total) * 100) : null };
    });
  }
}

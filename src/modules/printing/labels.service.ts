import { Injectable } from '@nestjs/common';
import type { Content } from 'pdfmake/interfaces';
import { Errors } from '../../common/errors/app.exception';
import { D } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { QUALITY_LABELS, QualityClass } from '../catalog/entities/product.entity';
import { ProductsService } from '../catalog/products.service';
import { Document, DocumentLine } from '../documents/entities/document.entity';
import { PdfService } from './pdf.service';

export interface LabelItem {
  productId: string;
  unitId?: string;
  copies: number;
  warehouseId?: string | null;
  serialItemId?: string | null;
}

const MM = 2.8346;
const MAX_LABELS = 2000;

/**
 * Этикетки товара в PDF (ТЗ 21.1): название, номер и бренд, штрихкод, место, класс качества; для экземпляра — его номер.
 * Товарам без штрихкода выдаётся внутренний EAN-13 (ТЗ 4.4). Размер по умолчанию 58×40 мм.
 */
@Injectable()
export class LabelsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly products: ProductsService,
    private readonly pdf: PdfService,
    private readonly audit: AuditService,
  ) {}

  /**
   * По документу (приёмка, оприходование, ввод остатков): mode=all — на каждую штуку;
   * without_barcode — только товарам без штрихкода; unpack — «этикетки на вскрытие» упаковок (на штуки внутри).
   */
  async forDocument(documentId: string, mode: 'all' | 'without_barcode' | 'unpack' = 'all', size?: { w: number; h: number }) {
    const items = await this.tenantTx.run(async (tx) => {
      const doc = await tx.repo(Document, 'Документ').getById(documentId);
      const lines = await tx.repo(DocumentLine).find({ where: { documentId: doc.id }, order: { lineNo: 'ASC' } });
      const out: LabelItem[] = [];
      for (const l of lines) {
        if (l.serialItemIds.length) {
          for (const sid of l.serialItemIds) out.push({ productId: l.productId, copies: 1, warehouseId: doc.warehouseId, serialItemId: sid });
          continue;
        }
        const hasBarcode = (await tx.query(`SELECT 1 FROM product_barcodes WHERE tenant_id = $1 AND product_id = $2 LIMIT 1`, [tx.tenantId, l.productId])).length > 0;
        if (mode === 'without_barcode' && hasBarcode) continue;
        if (mode === 'unpack') {
          if (D(l.factor).lte(1)) continue;
          out.push({ productId: l.productId, copies: Number(l.baseQty), warehouseId: doc.warehouseId });
        } else {
          out.push({ productId: l.productId, unitId: l.unitId, copies: Math.ceil(Number(l.qty)), warehouseId: doc.warehouseId });
        }
      }
      return out;
    });
    return this.render(items, size);
  }

  async render(items: LabelItem[], size = { w: 58, h: 40 }) {
    const total = items.reduce((a, i) => a + i.copies, 0);
    if (!total) throw Errors.bad('NO_LABELS', 'Нечего печатать');
    if (total > MAX_LABELS) throw Errors.bad('TOO_MANY_LABELS', `За раз — не больше ${MAX_LABELS} этикеток`);
    const data = await this.tenantTx.run((tx) => this.collect(tx, items));
    const pages: Content[] = [];
    for (const d of data) {
      const img = await this.pdf.barcode(d.barcode);
      for (let i = 0; i < d.copies; i++) {
        pages.push({
          stack: [
            { text: d.name, bold: true, fontSize: 8, maxHeight: 22 } as any,
            { text: [d.brand, d.number].filter(Boolean).join(' · '), fontSize: 7, margin: [0, 1, 0, 1] },
            { image: img, width: (size.w - 8) * MM, height: (size.h - 22) * MM, alignment: 'center' } as any,
            {
              columns: [
                { text: d.place ? `Место: ${d.place}` : '', fontSize: 7 },
                { text: d.serial ? `№ ${d.serial}` : d.quality, fontSize: 7, alignment: 'right' },
              ],
            },
          ],
          pageBreak: pages.length ? 'before' : undefined,
        });
      }
    }
    return this.pdf.render({
      pageSize: { width: size.w * MM, height: size.h * MM },
      pageMargins: [3 * MM, 2 * MM, 3 * MM, 1 * MM],
      content: pages,
      info: { title: 'Этикетки' },
    });
  }

  private async collect(tx: TenantTx, items: LabelItem[]) {
    const out: { name: string; brand: string | null; number: string | null; barcode: string; place: string | null; quality: string; serial: string | null; copies: number }[] = [];
    for (const it of items) {
      const [p] = await tx.query(
        `SELECT p.id, p.name, p.quality_class, b.name AS brand,
                (SELECT n.number FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id ORDER BY (n.type = 'manufacturer') DESC LIMIT 1) AS number
           FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE p.tenant_id = $1 AND p.id = $2`,
        [tx.tenantId, it.productId],
      );
      if (!p) throw Errors.notFound('Товар');
      const unitId = it.unitId ?? (await this.products.baseUnit(tx, p.id)).id;
      let [bc] = await tx.query(`SELECT barcode FROM product_barcodes WHERE tenant_id = $1 AND product_id = $2 AND unit_id = $3 ORDER BY created_at LIMIT 1`, [tx.tenantId, p.id, unitId]);
      if (!bc) {
        const created = await this.products.addBarcodeInTx(tx, p.id, unitId, undefined, false);
        bc = { barcode: created.barcode };
        await this.audit.log(tx, { action: 'product.barcode_add', entityType: 'product', entityId: p.id, summary: `Внутренний штрихкод ${created.barcode} для этикетки` });
      }
      let serial: string | null = null;
      if (it.serialItemId) {
        const [s] = await tx.query(`SELECT serial_number FROM serial_items WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, it.serialItemId]);
        serial = s?.serial_number ?? null;
      }
      const [pl] = it.warehouseId ? await tx.query(`SELECT place FROM product_places WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3`, [tx.tenantId, p.id, it.warehouseId]) : [];
      out.push({
        name: p.name,
        brand: p.brand,
        number: p.number,
        barcode: serial && /^[\x20-\x7e]+$/.test(serial) ? serial : bc.barcode,
        place: pl?.place ?? null,
        quality: QUALITY_LABELS[p.quality_class as QualityClass] ?? '',
        serial,
        copies: it.copies,
      });
    }
    return out;
  }
}

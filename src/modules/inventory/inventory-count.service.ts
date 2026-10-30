import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { D, Decimal } from '../../common/utils/decimal';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../auth/scope.service';
import { CategoriesService } from '../catalog/categories.service';
import { Product, ProductBarcode, ProductUnit } from '../catalog/entities/product.entity';
import { DocumentsService } from '../documents/documents.service';
import { Document, DocumentLink } from '../documents/entities/document.entity';
import { InventoryCount, InventorySheet, SerialItem } from './entities/stock.entity';

export interface InventoryScope {
  categoryId?: string;
  brandId?: string;
  place?: string;
  productIds?: string[];
}

/**
 * Инвентаризация без остановки продаж (ТЗ 9.3): учётное количество берётся на время скана,
 * несколько листов подсчёта суммируются, поздно пришедшие движения показываются отдельно.
 * Итог — оприходование излишков и списание недостачи.
 */
@Injectable()
export class InventoryCountService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly docs: DocumentsService,
    private readonly categories: CategoriesService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: { warehouseId: string; scope?: InventoryScope; comment?: string; sheetName?: string }) {
    return this.tenantTx.run(async (tx) => {
      await this.scope.assertWarehouse(tx, dto.warehouseId);
      if (dto.scope?.categoryId) await this.categories.subtreeIds(tx, dto.scope.categoryId);
      const doc = await this.docs.createInTx(tx, {
        type: 'inventory',
        warehouseId: dto.warehouseId,
        comment: dto.comment,
        extra: { scope: dto.scope ?? {} },
        lines: [],
      });
      doc.extra = { ...doc.extra, scope: dto.scope ?? {}, startedAt: new Date().toISOString() };
      await tx.repo(Document).save(doc);
      await tx.repo(InventorySheet).insert({ documentId: doc.id, name: dto.sheetName ?? 'Лист 1' });
      return this.viewInTx(tx, doc.id);
    });
  }

  async addSheet(id: string, name: string, assignedTo?: string) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.openDoc(tx, id);
      return tx.repo(InventorySheet).insert({ documentId: doc.id, name, assignedTo: assignedTo ?? null });
    });
  }

  /**
   * Скан или ввод количества. mode=add — прибавить (скан +1), set — заменить количество товара в этом листе.
   * Вместо productId можно передать штрихкод — упаковка считается по коэффициенту.
   */
  async count(id: string, dto: { sheetId: string; productId?: string; barcode?: string; qty: string; mode?: 'add' | 'set'; scannedAt?: string; serialItemId?: string; place?: string }) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.openDoc(tx, id);
      const sheet = await tx.repo(InventorySheet, 'Лист').getById(dto.sheetId);
      if (sheet.documentId !== doc.id) throw Errors.notFound('Лист');
      if (sheet.status === 'done') throw Errors.conflict('SHEET_DONE', 'Лист уже закрыт');
      let productId = dto.productId;
      let factor = D(1);
      if (!productId && dto.barcode) {
        const bcs = await tx.repo(ProductBarcode).find({ where: { barcode: dto.barcode.trim() } });
        if (!bcs.length) throw Errors.notFound('Товар по штрихкоду');
        if (bcs.length > 1) throw Errors.conflict('BARCODE_AMBIGUOUS', 'Штрихкод у нескольких товаров — выберите товар', { productIds: bcs.map((b) => b.productId) });
        productId = bcs[0].productId;
        const unit = await tx.repo(ProductUnit).findById(bcs[0].unitId);
        factor = D(unit?.factor ?? 1);
      }
      if (!productId) throw Errors.bad('PRODUCT_REQUIRED', 'Укажите товар или штрихкод');
      const p = await tx.repo(Product, 'Товар').getById(productId);
      if (p.kind !== 'goods') throw Errors.bad('NOT_GOODS', 'Услуги и комплекты не считаются');
      let q = D(dto.qty).mul(factor);
      if (dto.serialItemId) {
        const it = await tx.repo(SerialItem, 'Экземпляр').getById(dto.serialItemId);
        if (it.productId !== p.id) throw Errors.bad('SERIAL_MISMATCH', 'Экземпляр другого товара');
        q = D(1);
        const dup = await tx.repo(InventoryCount).count({ where: { documentId: doc.id, serialItemId: it.id } });
        if (dup) return { duplicate: true, productId: p.id };
      }
      if (q.isNegative()) throw Errors.bad('BAD_QTY', 'Количество не может быть отрицательным');
      const scannedAt = dto.scannedAt ? new Date(dto.scannedAt) : new Date();
      if (dto.mode === 'set') await tx.repo(InventoryCount).hardDelete({ documentId: doc.id, sheetId: sheet.id, productId: p.id });
      await tx.repo(InventoryCount).insert({ documentId: doc.id, sheetId: sheet.id, productId: p.id, qty: q, scannedAt, serialItemId: dto.serialItemId ?? null, place: dto.place ?? null });
      const [{ total }] = await tx.query(
        `SELECT coalesce(sum(qty), 0) AS total FROM inventory_counts WHERE tenant_id = $1 AND document_id = $2 AND product_id = $3`,
        [tx.tenantId, doc.id, p.id],
      );
      return { productId: p.id, name: p.name, counted: D(total).toFixed() };
    });
  }

  async view(id: string) {
    return this.tenantTx.run((tx) => this.viewInTx(tx, id));
  }

  /** Строки сверки: товары области и посчитанные; учётное — на время последнего скана товара. */
  async viewInTx(tx: TenantTx, id: string) {
    const doc = await tx.repo(Document, 'Инвентаризация').getById(id);
    if (doc.type !== 'inventory') throw Errors.notFound('Инвентаризация');
    await this.scope.assertWarehouse(tx, doc.warehouseId!);
    const rows = await this.rows(tx, doc);
    const sheets = await tx.repo(InventorySheet).find({ where: { documentId: doc.id }, order: { createdAt: 'ASC' } });
    const late = await tx.query(
      `SELECT m.id, m.product_id AS "productId", p.name, m.qty, m.moved_at AS "movedAt", m.created_at AS "receivedAt", d.number
         FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN documents d ON d.id = m.document_id
         JOIN (SELECT product_id, max(scanned_at) AS at, min(created_at) AS first_created FROM inventory_counts
                WHERE tenant_id = $1 AND document_id = $2 GROUP BY product_id) c ON c.product_id = m.product_id
        WHERE m.tenant_id = $1 AND m.warehouse_id = $3 AND m.moved_at <= c.at AND m.created_at > c.first_created`,
      [tx.tenantId, doc.id, doc.warehouseId],
    );
    return {
      ...doc,
      sheets,
      rows,
      lateMovements: late,
      summary: {
        products: rows.length,
        counted: rows.filter((r) => r.countedAt).length,
        surplus: rows.filter((r) => D(r.diff).gt(0)).length,
        shortage: rows.filter((r) => D(r.diff).lt(0)).length,
      },
    };
  }

  private async rows(tx: TenantTx, doc: Document) {
    const scope: InventoryScope = doc.extra?.scope ?? {};
    const params: unknown[] = [tx.tenantId, doc.warehouseId, doc.id];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const filters: string[] = [];
    if (scope.categoryId) filters.push(`pr.category_id = ANY(${p(await this.categories.subtreeIds(tx, scope.categoryId))}::uuid[])`);
    if (scope.brandId) filters.push(`pr.brand_id = ${p(scope.brandId)}`);
    if (scope.place) filters.push(`pl.place = ${p(scope.place)}`);
    if (scope.productIds?.length) filters.push(`pr.id = ANY(${p(scope.productIds)}::uuid[])`);
    const scopeSql = filters.length ? filters.join(' AND ') : 'true';
    const rows = await tx.query(
      `WITH counted AS (
         SELECT product_id, sum(qty) AS qty, max(scanned_at) AS at FROM inventory_counts
          WHERE tenant_id = $1 AND document_id = $3 GROUP BY product_id),
       scoped AS (
         SELECT pr.id FROM products pr
           LEFT JOIN product_places pl ON pl.tenant_id = pr.tenant_id AND pl.product_id = pr.id AND pl.warehouse_id = $2
           JOIN stock_balances b ON b.tenant_id = pr.tenant_id AND b.product_id = pr.id AND b.warehouse_id = $2 AND b.qty <> 0
          WHERE pr.tenant_id = $1 AND pr.kind = 'goods' AND NOT pr.no_stock_control AND ${scopeSql})
       SELECT p.id AS "productId", p.name, p.sku, p.base_unit AS "baseUnit", p.is_serial AS "isSerial", pl.place,
              c.qty AS counted, c.at AS "countedAt",
              coalesce((SELECT sum(m.qty) FROM stock_movements m WHERE m.tenant_id = $1 AND m.product_id = p.id AND m.warehouse_id = $2
                         AND m.moved_at <= coalesce(c.at, now())), 0) AS book
         FROM products p
         LEFT JOIN counted c ON c.product_id = p.id
         LEFT JOIN product_places pl ON pl.tenant_id = p.tenant_id AND pl.product_id = p.id AND pl.warehouse_id = $2
        WHERE p.tenant_id = $1 AND (p.id IN (SELECT id FROM scoped) OR c.product_id IS NOT NULL)
        ORDER BY pl.place NULLS LAST, p.name`,
      params,
    );
    return rows.map((r: any) => {
      const counted = D(r.counted ?? 0);
      const book = D(r.book);
      return { ...r, counted: counted.toFixed(), book: book.toFixed(), diff: counted.minus(book).toFixed() };
    });
  }

  /**
   * Завершить: излишки — оприходование по текущей средней, недостача — списание «недостача».
   * Непосчитанные товары области считаются нулём (uncountedAsZero), иначе пропускаются.
   */
  async finish(id: string, version: number, uncountedAsZero = true) {
    return this.tenantTx.run(async (tx) => {
      const doc = await this.docs.lockDoc(tx, id, version);
      if (doc.type !== 'inventory') throw Errors.notFound('Инвентаризация');
      if (doc.status === 'posted') throw Errors.conflict('INVENTORY_DONE', 'Инвентаризация уже завершена');
      await this.scope.assertWarehouse(tx, doc.warehouseId!);
      const rows = (await this.rows(tx, doc)).filter((r) => r.countedAt || uncountedAsZero);
      const surplus: { productId: string; qty: Decimal }[] = [];
      const shortage: { productId: string; qty: Decimal; serialItemIds?: string[] }[] = [];
      const warnings: string[] = [];
      for (const r of rows) {
        const diff = D(r.diff);
        if (diff.isZero()) continue;
        if (r.isSerial) {
          // Серийные — по экземплярам: не отсканированные на складе — недостача
          const missing = await tx.query<{ id: string }>(
            `SELECT s.id FROM serial_items s WHERE s.tenant_id = $1 AND s.product_id = $2 AND s.warehouse_id = $3 AND s.status = 'in_stock'
                AND s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM inventory_counts c WHERE c.tenant_id = $1 AND c.document_id = $4 AND c.serial_item_id = s.id)`,
            [tx.tenantId, r.productId, doc.warehouseId, doc.id],
          );
          if (missing.length) shortage.push({ productId: r.productId, qty: D(missing.length), serialItemIds: missing.map((m) => m.id) });
          if (diff.gt(0)) warnings.push(`«${r.name}»: излишек серийных экземпляров — оформите приход с номерами`);
          continue;
        }
        if (diff.gt(0)) surplus.push({ productId: r.productId, qty: diff });
        else shortage.push({ productId: r.productId, qty: diff.neg() });
      }
      const result: Record<string, string | null> = { surplusDocumentId: null, writeoffDocumentId: null };
      if (surplus.length) {
        const d = await this.docs.createInTx(
          tx,
          { type: 'surplus', warehouseId: doc.warehouseId!, comment: `Излишки по инвентаризации ${doc.number}`, lines: surplus.map((s) => ({ productId: s.productId, qty: s.qty.toFixed() })) },
          { system: true },
        );
        await this.docs.postInTx(tx, d, { system: true });
        await tx.repo(DocumentLink).insert({ fromId: doc.id, toId: d.id, kind: 'result' });
        result.surplusDocumentId = d.id;
      }
      if (shortage.length) {
        const d = await this.docs.createInTx(
          tx,
          {
            type: 'writeoff',
            warehouseId: doc.warehouseId!,
            comment: `Недостача по инвентаризации ${doc.number}`,
            extra: { reason: 'shortage' },
            lines: shortage.map((s) => ({ productId: s.productId, qty: s.qty.toFixed(), serialItemIds: s.serialItemIds })),
          },
          { system: true },
        );
        await this.docs.postInTx(tx, d, { system: true });
        await tx.repo(DocumentLink).insert({ fromId: doc.id, toId: d.id, kind: 'result' });
        result.writeoffDocumentId = d.id;
      }
      doc.status = 'posted';
      doc.postedAt = new Date();
      doc.postedBy = tx.userId;
      doc.extra = { ...doc.extra, finishedAt: new Date().toISOString(), result, warnings, uncountedAsZero };
      await tx.repo(Document).save(doc);
      await tx.query(`UPDATE inventory_sheets SET status = 'done' WHERE tenant_id = $1 AND document_id = $2`, [tx.tenantId, doc.id]);
      await this.audit.log(tx, {
        action: 'inventory.finish',
        entityType: 'document',
        entityId: doc.id,
        storeId: doc.storeId,
        summary: `Инвентаризация ${doc.number}: излишков ${surplus.length}, недостач ${shortage.length}`,
        after: result,
        important: true,
      });
      return { ...(await this.viewInTx(tx, doc.id)), result, warnings };
    });
  }

  private async openDoc(tx: TenantTx, id: string) {
    const doc = await tx.repo(Document, 'Инвентаризация').getById(id);
    if (doc.type !== 'inventory') throw Errors.notFound('Инвентаризация');
    if (doc.status === 'posted') throw Errors.conflict('INVENTORY_DONE', 'Инвентаризация завершена');
    await this.scope.assertWarehouse(tx, doc.warehouseId!);
    return doc;
  }
}

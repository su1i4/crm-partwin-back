import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { normalizePartNumber } from '../../common/utils/part-number';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from '../catalog/brands.service';
import { Product } from '../catalog/entities/product.entity';
import { CrossSource, CrossType, PartCross, PartNumber } from './entities/part-number.entity';

export interface CrossInput {
  aBrand?: string | null;
  aNumber: string;
  bBrand?: string | null;
  bNumber: string;
  crossType?: CrossType;
}

interface NumKey {
  brandId: string | null;
  normalized: string;
  type?: string;
}

export interface AnalogRow {
  productId: string;
  level: 1 | 2;
  /** Как связаны: cross — через кросс, oem — общий OEM-номер */
  via: 'cross' | 'oem';
  crossType: CrossType | null;
  matchedNumber: string;
  throughAnalog: boolean;
}

/** Аналоги (кроссы) и поиск аналогов на 2 уровня с защитой от циклов (ТЗ 4.2). */
@Injectable()
export class CrossesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly brands: BrandsService,
    private readonly audit: AuditService,
  ) {}

  /** Добавить кросс (идемпотентно). Для full/partial пара упорядочивается, чтобы A↔B и B↔A не дублировались. */
  async addInTx(tx: TenantTx, input: CrossInput, source: CrossSource = 'manual', sourceRefId: string | null = null) {
    const aNorm = normalizePartNumber(input.aNumber);
    const bNorm = normalizePartNumber(input.bNumber);
    if (!aNorm || !bNorm) throw Errors.bad('BAD_NUMBER', 'Пустой номер в кроссе');
    const aBrand = input.aBrand ? await this.brands.resolve(tx, input.aBrand, true) : null;
    const bBrand = input.bBrand ? await this.brands.resolve(tx, input.bBrand, true) : null;
    if (aNorm === bNorm && (aBrand?.id ?? '') === (bBrand?.id ?? '')) throw Errors.bad('CROSS_SELF', 'Номер не может быть аналогом сам себе');
    const type = input.crossType ?? 'full';
    let a = { brandId: aBrand?.id ?? null, number: input.aNumber.trim(), normalized: aNorm };
    let b = { brandId: bBrand?.id ?? null, number: input.bNumber.trim(), normalized: bNorm };
    if (type !== 'oem_replacement' && `${a.normalized}|${a.brandId ?? ''}` > `${b.normalized}|${b.brandId ?? ''}`) [a, b] = [b, a];
    const rows = await tx.query(
      `INSERT INTO part_crosses (tenant_id, created_by, a_brand_id, a_number, a_normalized, a_brand_key,
                                 b_brand_id, b_number, b_normalized, b_brand_key, cross_type, source, source_ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (tenant_id, a_normalized, a_brand_key, b_normalized, b_brand_key) DO NOTHING
       RETURNING id`,
      [tx.tenantId, tx.userId, a.brandId, a.number, a.normalized, a.brandId ?? '', b.brandId, b.number, b.normalized, b.brandId ?? '', type, source, sourceRefId],
    );
    return { id: rows[0]?.id ?? null, created: rows.length > 0 };
  }

  async add(input: CrossInput) {
    return this.tenantTx.run(async (tx) => {
      const r = await this.addInTx(tx, input);
      if (r.created) {
        await this.audit.log(tx, {
          action: 'cross.create',
          entityType: 'cross',
          entityId: r.id,
          summary: `${input.aBrand ?? ''} ${input.aNumber} ↔ ${input.bBrand ?? ''} ${input.bNumber}`.trim(),
        });
      }
      return r;
    });
  }

  async remove(id: string) {
    await this.tenantTx.run(async (tx) => {
      const c = await tx.repo(PartCross, 'Кросс').getById(id);
      await tx.repo(PartCross).hardDelete({ id });
      await this.audit.log(tx, { action: 'cross.delete', entityType: 'cross', entityId: id, before: c });
    });
  }

  /** Кроссы, касающиеся номеров товара (для вкладки «Номера и аналоги»). */
  async listForProduct(productId: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      const nums = await tx.repo(PartNumber).find({ where: { productId } });
      const norms = [...new Set(nums.map((n) => n.normalized))];
      if (!norms.length) return [];
      return tx.query(
        `SELECT c.id, c.a_number AS "aNumber", ab.name AS "aBrand", c.b_number AS "bNumber", bb.name AS "bBrand",
                c.cross_type AS "crossType", c.source, c.created_at AS "createdAt"
           FROM part_crosses c
           LEFT JOIN brands ab ON ab.id = c.a_brand_id
           LEFT JOIN brands bb ON bb.id = c.b_brand_id
          WHERE c.tenant_id = $1 AND (c.a_normalized = ANY($2) OR c.b_normalized = ANY($2))
          ORDER BY c.created_at DESC LIMIT 500`,
        [tx.tenantId, norms],
      );
    });
  }

  /**
   * Аналоги товара: уровень 1 — кроссы и общие OEM-номера; уровень 2 — то же от аналогов первого уровня
   * (помечается «через аналог»). Уже встреченные номера и товары не обходим повторно — циклы невозможны.
   */
  async analogsInTx(tx: TenantTx, productIds: string[], maxLevel: 1 | 2 = 2): Promise<AnalogRow[]> {
    const startNums = await this.numbersOf(tx, productIds);
    const seenProducts = new Set(productIds);
    const seenNums = new Set(startNums.map(k));
    const result: AnalogRow[] = [];
    let frontier = startNums;

    for (let level = 1 as 1 | 2; level <= maxLevel && frontier.length; level = (level + 1) as 1 | 2) {
      const next: NumKey[] = [];

      // 1) Кроссы: номер ↔ номер
      const norms = [...new Set(frontier.map((f) => f.normalized))];
      const crosses = await tx.query(
        `SELECT a_brand_id, a_normalized, b_brand_id, b_normalized, cross_type FROM part_crosses
          WHERE tenant_id = $1 AND (a_normalized = ANY($2) OR b_normalized = ANY($2))`,
        [tx.tenantId, norms],
      );
      const linked: (NumKey & { crossType: CrossType; from: string })[] = [];
      for (const c of crosses) {
        for (const f of frontier) {
          if (matches(f, c.a_brand_id, c.a_normalized)) linked.push({ brandId: c.b_brand_id, normalized: c.b_normalized, crossType: c.cross_type, from: f.normalized });
          if (matches(f, c.b_brand_id, c.b_normalized)) linked.push({ brandId: c.a_brand_id, normalized: c.a_normalized, crossType: c.cross_type, from: f.normalized });
        }
      }

      // 2) Товары по связанным номерам + товары с общим OEM-номером
      const targetNorms = [...new Set([...linked.map((l) => l.normalized), ...norms])];
      const candidates = await tx.query(
        `SELECT n.product_id, n.brand_id, n.normalized, n.type FROM part_numbers n
           JOIN products p ON p.id = n.product_id AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
          WHERE n.tenant_id = $1 AND n.normalized = ANY($2) AND n.product_id <> ALL($3::uuid[])`,
        [tx.tenantId, targetNorms, [...seenProducts]],
      );
      for (const c of candidates) {
        if (seenProducts.has(c.product_id)) continue;
        const viaCross = linked.find((l) => matches(l, c.brand_id, c.normalized));
        const viaOem = !viaCross && frontier.find((f) => f.normalized === c.normalized && (f.type === 'oem' || c.type === 'oem' || f.brandId === c.brand_id));
        if (!viaCross && !viaOem) continue;
        seenProducts.add(c.product_id);
        result.push({
          productId: c.product_id,
          level,
          via: viaCross ? 'cross' : 'oem',
          crossType: viaCross ? viaCross.crossType : null,
          matchedNumber: c.normalized,
          throughAnalog: level === 2,
        });
      }

      // Номера найденных товаров — фронт следующего уровня
      const newIds = result.filter((r) => r.level === level).map((r) => r.productId);
      for (const n of await this.numbersOf(tx, newIds)) {
        if (!seenNums.has(k(n))) {
          seenNums.add(k(n));
          next.push(n);
        }
      }
      // Связанные кроссом номера без товара тоже идут во фронт (A→B→C, где у B нет карточки)
      for (const l of linked) {
        if (!seenNums.has(k(l))) {
          seenNums.add(k(l));
          next.push(l);
        }
      }
      frontier = next;
    }
    return result;
  }

  async analogs(productId: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      const rows = await this.analogsInTx(tx, [productId]);
      if (!rows.length) return [];
      const info = await tx.query(
        `SELECT p.id, p.name, p.sku, p.quality_class AS "qualityClass", b.name AS "brandName",
                (SELECT n.number FROM part_numbers n WHERE n.tenant_id = p.tenant_id AND n.product_id = p.id
                  ORDER BY (n.type = 'manufacturer') DESC LIMIT 1) AS "mainNumber"
           FROM products p LEFT JOIN brands b ON b.id = p.brand_id
          WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])`,
        [tx.tenantId, rows.map((r) => r.productId)],
      );
      return rows.map((r) => ({ ...r, ...info.find((i: any) => i.id === r.productId) }));
    });
  }

  private async numbersOf(tx: TenantTx, productIds: string[]): Promise<NumKey[]> {
    if (!productIds.length) return [];
    const rows = await tx.query(
      `SELECT brand_id, normalized, type FROM part_numbers WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`,
      [tx.tenantId, productIds],
    );
    return rows.map((r: any) => ({ brandId: r.brand_id, normalized: r.normalized, type: r.type }));
  }
}

const k = (n: NumKey) => `${n.normalized}|${n.brandId ?? ''}`;
/** Номер совпадает со стороной кросса: номер равен и бренды совместимы (не задан у одной из сторон — совпадает). */
function matches(n: NumKey, brandId: string | null, normalized: string) {
  return n.normalized === normalized && (!brandId || !n.brandId || brandId === n.brandId);
}

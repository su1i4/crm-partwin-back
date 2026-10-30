import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { internalEan13, normalizeBarcode } from '../../common/utils/barcode';
import { D, money, qty } from '../../common/utils/decimal';
import { normalizePartNumber, partNumberSkeleton } from '../../common/utils/part-number';
import { CountersService } from '../../database/tenant/counters.service';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { StoredFile } from '../files/entities/file.entity';
import { StockProbeService } from '../inventory/stock-probe.service';
import { PartNumber } from '../parts/entities/part-number.entity';
import { PricesService } from '../pricing/prices.service';
import { ApplicabilityService } from '../vehicles/applicability.service';
import { BrandsService } from './brands.service';
import { CategoriesService } from './categories.service';
import {
  BarcodeAddDto,
  CreateProductDto,
  QuickCreateProductDto,
  UnitInputDto,
  UnitUpdateDto,
  UpdateProductDto,
} from './dto/product.dto';
import { Brand } from './entities/brand.entity';
import { Category } from './entities/category.entity';
import { Attribute, PartType } from './entities/part-type.entity';
import { KitComponent, Product, ProductBarcode, ProductPhoto, ProductUnit, QUALITY_LABELS } from './entities/product.entity';
import { PartTypesService } from './part-types.service';
import { SearchTextService } from './search-text.service';

/** Карточка товара (ТЗ 4.1–4.4, 4.7). */
@Injectable()
export class ProductsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
    private readonly brands: BrandsService,
    private readonly categories: CategoriesService,
    private readonly partTypes: PartTypesService,
    private readonly counters: CountersService,
    private readonly prices: PricesService,
    private readonly applicability: ApplicabilityService,
    private readonly searchText: SearchTextService,
    private readonly stock: StockProbeService,
    private readonly audit: AuditService,
  ) {}

  // ── Создание ────────────────────────────────────────────

  async create(dto: CreateProductDto, opts: { quick?: boolean; importJobId?: string } = {}) {
    return this.tenantTx.run((tx) => this.createInTx(tx, dto, opts));
  }

  async createInTx(tx: TenantTx, dto: CreateProductDto, opts: { quick?: boolean; importJobId?: string } = {}) {
    const brand = await this.pickBrand(tx, dto);
    if (dto.categoryId) await tx.repo(Category, 'Категория').getById(dto.categoryId);
    if (dto.partTypeId) await tx.repo(PartType, 'Тип детали').getById(dto.partTypeId);
    const attributes = await this.validateAttributes(tx, dto.partTypeId ?? null, dto.attributes ?? {}, !opts.quick);
    const kind = dto.kind ?? 'goods';
    this.validateKindFlags(kind, dto);

    const sku = dto.sku ?? (await this.nextSku(tx));
    if (dto.sku && (await tx.repo(Product).count({ where: { sku: dto.sku } }))) {
      throw Errors.conflict('SKU_TAKEN', `Артикул ${dto.sku} уже занят`);
    }
    if (dto.number && brand) await this.assertNumberFree(tx, brand, dto.number, null);

    const product = await tx.repo(Product).insert({
      name: dto.name,
      sku,
      kind,
      brandId: brand?.id ?? null,
      qualityClass: dto.qualityClass ?? (brand?.isCarMaker ? 'original' : brand?.isNoBrand ? 'copy' : 'aftermarket'),
      categoryId: dto.categoryId ?? null,
      partTypeId: dto.partTypeId ?? null,
      attributes,
      description: dto.description ?? null,
      sellerNote: dto.sellerNote ?? null,
      warrantyDays: dto.warrantyDays ?? null,
      returnDays: dto.returnDays ?? null,
      returnConditions: dto.returnConditions ?? null,
      baseUnit: dto.baseUnit ?? 'шт',
      fractional: !!dto.fractional,
      qtyStep: qty(dto.qtyStep ?? (dto.fractional ? '0.1' : '1')),
      isSerial: !!dto.isSerial,
      noStockControl: kind === 'service' ? true : !!dto.noStockControl || (await this.categoryNoStockControl(tx, dto.categoryId)),
      priceNegotiable: !!dto.priceNegotiable,
      minPrice: dto.minPrice ? money(dto.minPrice) : null,
      recommendedPrice: dto.recommendedPrice ? money(dto.recommendedPrice) : null,
      tags: dto.tags ?? [],
      status: 'active',
      quickCreated: !!opts.quick,
      importJobId: opts.importJobId ?? null,
    });

    const base = await tx.repo(ProductUnit).insert({
      productId: product.id,
      name: product.baseUnit,
      factor: D(1),
      isBase: true,
      priceMode: 'computed',
    });

    await this.replaceNumbers(tx, product, brand, dto.number, dto.oemNumbers);

    const barcodes = (dto.barcodes ?? []).map(normalizeBarcode).filter(Boolean);
    for (const code of barcodes) await this.addBarcodeInTx(tx, product.id, base.id, code, !!dto.confirmDuplicateBarcode);
    if (!barcodes.length && dto.generateBarcode) await this.addBarcodeInTx(tx, product.id, base.id, undefined, false);

    for (const u of dto.units ?? []) await this.addUnitInTx(tx, product, u, !!dto.confirmDuplicateBarcode);
    if (dto.kitComponents) await this.setKit(tx, product, dto.kitComponents);
    if (dto.photoFileIds) await this.setPhotos(tx, product.id, dto.photoFileIds);
    if (dto.applicability?.length) await this.applicability.replace(tx, product.id, dto.applicability);
    if (dto.retailPrice) {
      const retail = await this.prices.retailType(tx);
      await this.prices.set(tx, [{ productId: product.id, priceTypeId: retail.id, price: dto.retailPrice }], 'Цена при создании товара', !opts.importJobId);
    }

    // При импорте search_text пересобирается пачкой в конце куска
    if (!opts.importJobId) await this.searchText.rebuild(tx, [product.id]);
    if (!opts.importJobId) {
      await this.audit.log(tx, {
        action: opts.quick ? 'product.quick_create' : 'product.create',
        entityType: 'product',
        entityId: product.id,
        summary: `${product.sku} ${product.name}`,
        after: product,
      });
    }
    return product;
  }

  /** Быстрое создание при продаже или приёмке (ТЗ 4.7). */
  async quickCreate(dto: QuickCreateProductDto) {
    return this.tenantTx.run(async (tx) => {
      const p = await this.createInTx(
        tx,
        {
          name: dto.name,
          number: dto.number,
          brand: dto.brand ?? (dto.number ? undefined : undefined),
          qualityClass: dto.qualityClass,
          categoryId: dto.categoryId,
          retailPrice: dto.price,
          barcodes: dto.barcode ? [dto.barcode] : undefined,
          confirmDuplicateBarcode: dto.confirmDuplicateBarcode,
          photoFileIds: dto.photoFileId ? [dto.photoFileId] : undefined,
          noStockControl: dto.noStockControl,
          applicability: dto.vehicles?.map((text) => ({ text })),
        },
        { quick: true },
      );
      return this.cardInTx(tx, p.id);
    });
  }

  // ── Изменение ───────────────────────────────────────────

  async update(id: string, dto: UpdateProductDto) {
    return this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(id, { lock: { mode: 'pessimistic_write' } } as any);
      if (p.version !== dto.version) throw Errors.versionConflict();
      const before = await this.cardInTx(tx, id);

      const brandChanged = dto.brand !== undefined || dto.brandId !== undefined;
      const brand = brandChanged ? await this.pickBrand(tx, dto) : p.brandId ? await tx.repo(Brand).findById(p.brandId) : null;

      if (dto.sku && dto.sku !== p.sku && (await tx.repo(Product).count({ where: { sku: dto.sku } }))) {
        throw Errors.conflict('SKU_TAKEN', `Артикул ${dto.sku} уже занят`);
      }
      if (dto.categoryId) await tx.repo(Category, 'Категория').getById(dto.categoryId);
      if (dto.partTypeId) await tx.repo(PartType, 'Тип детали').getById(dto.partTypeId);
      const partTypeId = dto.partTypeId !== undefined ? dto.partTypeId : p.partTypeId;
      const attributes =
        dto.attributes !== undefined || dto.partTypeId !== undefined
          ? await this.validateAttributes(tx, partTypeId, { ...(dto.attributes ? {} : p.attributes), ...(dto.attributes ?? {}) }, true)
          : p.attributes;

      if (dto.baseUnit && dto.baseUnit !== p.baseUnit) {
        if (await this.stock.hasMovements(tx, id)) {
          throw Errors.conflict('BASE_UNIT_LOCKED', 'У товара есть движения — базовую единицу не поменять. Используйте «Пересортицу» в новый товар');
        }
        await tx.query(
          `UPDATE product_units SET name = $3 WHERE tenant_id = $1 AND product_id = $2 AND is_base`,
          [tx.tenantId, id, dto.baseUnit],
        );
      }
      const kind = dto.kind ?? p.kind;
      this.validateKindFlags(kind, { ...p, ...dto } as any);

      const patch: Partial<Product> = {
        name: dto.name,
        sku: dto.sku,
        kind: dto.kind,
        brandId: brandChanged ? (brand?.id ?? null) : undefined,
        qualityClass: dto.qualityClass,
        categoryId: dto.categoryId,
        partTypeId: dto.partTypeId,
        attributes,
        description: dto.description,
        sellerNote: dto.sellerNote,
        warrantyDays: dto.warrantyDays,
        returnDays: dto.returnDays,
        returnConditions: dto.returnConditions,
        baseUnit: dto.baseUnit,
        fractional: dto.fractional,
        qtyStep: dto.qtyStep !== undefined ? qty(dto.qtyStep) : undefined,
        isSerial: dto.isSerial,
        noStockControl: dto.noStockControl,
        priceNegotiable: dto.priceNegotiable,
        minPrice: dto.minPrice !== undefined ? (dto.minPrice === null ? null : money(dto.minPrice)) : undefined,
        recommendedPrice:
          dto.recommendedPrice !== undefined ? (dto.recommendedPrice === null ? null : money(dto.recommendedPrice)) : undefined,
        tags: dto.tags,
        status: dto.status,
      };
      if (dto.noStockControl === false && p.noStockControl) {
        // Снятие флага — только через ввод фактического остатка (ТЗ 4.7), этап 2
        throw Errors.conflict('STOCK_CONTROL_VIA_COUNT', 'Чтобы включить учёт остатка, введите фактический остаток документом (этап «Склад»)');
      }
      const saved = await tx.repo(Product).update(id, patch, dto.version);

      if (dto.number !== undefined || dto.oemNumbers !== undefined || brandChanged) {
        const currentMain = (await tx.repo(PartNumber).find({ where: { productId: id } })).find((n) => n.type === 'manufacturer' || (n.type === 'oem' && brand?.isNoBrand));
        const currentOem = (await tx.repo(PartNumber).find({ where: { productId: id, type: 'oem' } })).map((n) => n.number);
        await this.replaceNumbers(
          tx,
          saved,
          brand,
          dto.number !== undefined ? dto.number : currentMain?.number,
          dto.oemNumbers !== undefined ? dto.oemNumbers : currentOem,
        );
      }
      if (dto.kitComponents) await this.setKit(tx, saved, dto.kitComponents);
      if (dto.photoFileIds) await this.setPhotos(tx, id, dto.photoFileIds);
      if (dto.applicability) await this.applicability.replace(tx, id, dto.applicability);

      await this.searchText.rebuild(tx, [id]);
      const after = await this.cardInTx(tx, id);
      await this.audit.log(tx, {
        action: 'product.update',
        entityType: 'product',
        entityId: id,
        summary: `${saved.sku} ${saved.name}`,
        before: strip(before),
        after: strip(after),
      });
      return after;
    });
  }

  async archive(id: string, archived: boolean) {
    return this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(id);
      p.status = archived ? 'archived' : 'active';
      const saved = await tx.repo(Product).save(p);
      await this.audit.log(tx, { action: archived ? 'product.archive' : 'product.restore', entityType: 'product', entityId: id });
      return saved;
    });
  }

  async remove(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(id);
      if (p.version !== version) throw Errors.versionConflict();
      if (await this.stock.hasMovements(tx, id)) {
        throw Errors.conflict('PRODUCT_HAS_MOVEMENTS', 'По товару есть движения — его можно только отправить в архив');
      }
      await tx.repo(PartNumber).hardDelete({ productId: id });
      await tx.repo(ProductBarcode).hardDelete({ productId: id });
      await tx.repo(Product).softDelete(id);
      await this.audit.log(tx, { action: 'product.delete', entityType: 'product', entityId: id, before: p, important: true });
    });
  }

  // ── Карточка ────────────────────────────────────────────

  async card(id: string) {
    return this.tenantTx.run((tx) => this.cardInTx(tx, id));
  }

  async cardInTx(tx: TenantTx, id: string) {
    const p = await tx.repo(Product, 'Товар').getById(id);
    const [brand, category, partType, units, barcodes, numbers, photos, kit, prices, applicability, stock] = await Promise.all([
      p.brandId ? tx.repo(Brand).findById(p.brandId) : null,
      p.categoryId ? tx.repo(Category).findById(p.categoryId) : null,
      p.partTypeId ? tx.repo(PartType).findById(p.partTypeId) : null,
      tx.repo(ProductUnit).find({ where: { productId: id }, order: { isBase: 'DESC', factor: 'ASC' }, withDeleted: false }),
      tx.repo(ProductBarcode).find({ where: { productId: id }, order: { createdAt: 'ASC' } }),
      tx.repo(PartNumber).find({ where: { productId: id }, order: { createdAt: 'ASC' } }),
      tx.repo(ProductPhoto).find({ where: { productId: id }, order: { sort: 'ASC' } }),
      tx.repo(KitComponent).find({ where: { kitId: id } }),
      this.prices.current(tx, [id]),
      this.applicability.list(tx, id),
      this.stock.balances(tx, [id]),
    ]);
    const attributeDefs = await this.partTypes.attributesFor(tx, p.partTypeId);
    const inherited = await this.categories.effectiveSettings(tx, p.categoryId);
    const kitProducts = kit.length ? await tx.repo(Product).findByIds(kit.map((k) => k.componentId)) : [];
    const brandIds = [...new Set(numbers.map((n) => n.brandId).filter(Boolean) as string[])];
    const numberBrands = brandIds.length ? await tx.repo(Brand).findByIds(brandIds) : [];
    const main = numbers.find((n) => n.type === 'manufacturer') ?? (brand?.isNoBrand ? numbers.find((n) => n.type === 'oem') : undefined);
    // Возвраты «не подошло» без разбора — пометка в карточке (ТЗ 5.2)
    const fitIssues: { id: string; vehicleTitle: string; createdAt: Date }[] = await tx.query(
      `SELECT id, vehicle_title AS "vehicleTitle", created_at AS "createdAt" FROM product_fit_issues
        WHERE tenant_id = $1 AND product_id = $2 AND NOT resolved ORDER BY created_at DESC LIMIT 20`,
      [tx.tenantId, id],
    );

    return {
      ...p,
      qualityLabel: QUALITY_LABELS[p.qualityClass],
      brand: brand ? { id: brand.id, name: brand.name, isCarMaker: brand.isCarMaker, isNoBrand: brand.isNoBrand } : null,
      category: category ? { id: category.id, name: category.name, path: category.path } : null,
      partType: partType ? { id: partType.id, name: partType.name } : null,
      attributeDefs,
      mainNumber: main?.number ?? null,
      numbers: numbers.map((n) => ({
        id: n.id,
        type: n.type,
        number: n.number,
        normalized: n.normalized,
        brandId: n.brandId,
        brandName: numberBrands.find((b) => b.id === n.brandId)?.name ?? null,
      })),
      units: units.map((u) => ({ ...u, barcodes: barcodes.filter((b) => b.unitId === u.id) })),
      photos: photos.map((ph) => ({ id: ph.id, fileId: ph.fileId, sort: ph.sort })),
      kitComponents: kit.map((k) => ({
        productId: k.componentId,
        qty: k.qty,
        name: kitProducts.find((x) => x.id === k.componentId)?.name ?? null,
      })),
      prices,
      applicability,
      fitIssues,
      fitWarning: fitIssues.length ? `Есть возвраты «не подошло»: ${[...new Set(fitIssues.map((f) => f.vehicleTitle))].slice(0, 3).join(', ')}` : null,
      stock,
      // Гарантия и возврат: своё значение или из категории
      effective: {
        warrantyDays: p.warrantyDays ?? inherited.warrantyDays ?? null,
        returnDays: p.returnDays ?? inherited.returnDays ?? null,
        returnConditions: p.returnConditions ?? inherited.returnConditions ?? null,
        pairHint: !!inherited.pairHint,
        negativeStock: inherited.negativeStock ?? null,
      },
    };
  }

  // ── Единицы и упаковки ──────────────────────────────────

  async addUnit(productId: string, dto: UnitInputDto & { confirmDuplicate?: boolean }) {
    return this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(productId);
      const u = await this.addUnitInTx(tx, p, dto, !!dto.confirmDuplicate);
      await this.searchText.rebuild(tx, [productId]);
      await this.audit.log(tx, { action: 'product.unit_add', entityType: 'product', entityId: productId, after: u });
      return u;
    });
  }

  private async addUnitInTx(tx: TenantTx, p: Product, dto: UnitInputDto, confirmDup: boolean) {
    const factor = qty(dto.factor);
    if (factor.lte(0)) throw Errors.bad('BAD_FACTOR', 'Коэффициент должен быть больше нуля');
    const unit = await tx.repo(ProductUnit).insert({
      productId: p.id,
      name: dto.name,
      factor,
      isBase: false,
      priceMode: dto.priceMode ?? 'computed',
    });
    if (dto.barcode) await this.addBarcodeInTx(tx, p.id, unit.id, normalizeBarcode(dto.barcode), confirmDup);
    return unit;
  }

  async updateUnit(productId: string, unitId: string, dto: UnitUpdateDto) {
    return this.tenantTx.run(async (tx) => {
      const unit = await tx.repo(ProductUnit, 'Единица').getById(unitId);
      if (unit.productId !== productId) throw Errors.notFound('Единица');
      if (dto.factor !== undefined) {
        if (unit.isBase) throw Errors.bad('BASE_UNIT_FACTOR', 'У базовой единицы коэффициент всегда 1');
        if (!qty(dto.factor).eq(unit.factor) && (await this.stock.hasMovements(tx, productId, unitId))) {
          throw Errors.conflict('UNIT_LOCKED', 'По упаковке есть движения: создайте новую упаковку, старую отправьте в архив');
        }
      }
      const saved = await tx.repo(ProductUnit).update(
        unitId,
        { name: dto.name, factor: dto.factor ? qty(dto.factor) : undefined, priceMode: dto.priceMode },
        dto.version,
      );
      await this.audit.log(tx, { action: 'product.unit_update', entityType: 'product', entityId: productId, before: unit, after: saved });
      return saved;
    });
  }

  /** Упаковка в архив (удаление с историей). */
  async archiveUnit(productId: string, unitId: string) {
    await this.tenantTx.run(async (tx) => {
      const unit = await tx.repo(ProductUnit, 'Единица').getById(unitId);
      if (unit.productId !== productId) throw Errors.notFound('Единица');
      if (unit.isBase) throw Errors.bad('BASE_UNIT', 'Базовую единицу удалить нельзя');
      await tx.repo(ProductBarcode).hardDelete({ unitId });
      await tx.repo(ProductUnit).softDelete(unitId);
      await this.searchText.rebuild(tx, [productId]);
      await this.audit.log(tx, { action: 'product.unit_archive', entityType: 'product', entityId: productId, before: unit });
    });
  }

  // ── Штрихкоды ───────────────────────────────────────────

  async addBarcode(productId: string, dto: BarcodeAddDto) {
    return this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(productId);
      const unitId = dto.unitId ?? (await this.baseUnit(tx, p.id)).id;
      const unit = await tx.repo(ProductUnit, 'Единица').getById(unitId);
      if (unit.productId !== p.id) throw Errors.notFound('Единица');
      const bc = await this.addBarcodeInTx(tx, p.id, unitId, dto.barcode ? normalizeBarcode(dto.barcode) : undefined, !!dto.confirmDuplicate);
      await this.searchText.rebuild(tx, [p.id]);
      await this.audit.log(tx, { action: 'product.barcode_add', entityType: 'product', entityId: p.id, after: bc });
      return bc;
    });
  }

  async removeBarcode(productId: string, barcodeId: string) {
    await this.tenantTx.run(async (tx) => {
      const bc = await tx.repo(ProductBarcode, 'Штрихкод').getById(barcodeId);
      if (bc.productId !== productId) throw Errors.notFound('Штрихкод');
      await tx.repo(ProductBarcode).hardDelete({ id: barcodeId });
      await this.searchText.rebuild(tx, [productId]);
      await this.audit.log(tx, { action: 'product.barcode_remove', entityType: 'product', entityId: productId, before: bc });
    });
  }

  /**
   * Штрихкод (ТЗ 4.4). Пусто — внутренний EAN-13 (25…). Код уже у другого товара — 409 BARCODE_DUPLICATE,
   * если не подтверждено confirmDuplicate (китайские поставщики дают один код разным товарам).
   */
  async addBarcodeInTx(tx: TenantTx, productId: string, unitId: string, code: string | undefined, confirmDup: boolean) {
    let barcode = code;
    let isInternal = false;
    if (!barcode) {
      for (let i = 0; i < 5; i++) {
        barcode = internalEan13(await this.counters.next(tx, 'barcode.internal'));
        if (!(await tx.repo(ProductBarcode).count({ where: { barcode } }))) break;
      }
      isInternal = true;
    }
    const same = await tx.repo(ProductBarcode).findOne({ where: { productId, barcode } });
    if (same) throw Errors.conflict('BARCODE_EXISTS', 'У товара уже есть этот штрихкод');
    const others = await tx.query<{ id: string; name: string; sku: string }>(
      `SELECT p.id, p.name, p.sku FROM product_barcodes b JOIN products p ON p.id = b.product_id AND p.deleted_at IS NULL
        WHERE b.tenant_id = $1 AND b.barcode = $2 AND b.product_id <> $3`,
      [tx.tenantId, barcode, productId],
    );
    if (others.length && !confirmDup) {
      throw Errors.conflict('BARCODE_DUPLICATE', 'Этот штрихкод уже есть у другого товара. Подтвердите, если это правильно', {
        barcode,
        products: others,
      });
    }
    return tx.repo(ProductBarcode).insert({ productId, unitId, barcode: barcode!, isInternal, duplicateAccepted: others.length > 0 });
  }

  /** Товары по штрихкоду: одна строка — сразу в чек; несколько — окно выбора с фото и ценой (ТЗ 11.1). */
  async byBarcode(code: string) {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.query(
        `SELECT b.product_id AS "productId", b.unit_id AS "unitId", u.name AS "unitName", u.factor, p.name, p.sku, p.status
           FROM product_barcodes b
           JOIN products p ON p.id = b.product_id AND p.deleted_at IS NULL
           JOIN product_units u ON u.id = b.unit_id AND u.deleted_at IS NULL
          WHERE b.tenant_id = $1 AND b.barcode = $2 ORDER BY p.status, p.name`,
        [tx.tenantId, normalizeBarcode(code)],
      );
      return { barcode: code, matches: rows, ambiguous: rows.length > 1 };
    });
  }

  // ── Фото, комплект, цены ────────────────────────────────

  async setPhotos(tx: TenantTx, productId: string, fileIds: string[]) {
    const files = await tx.repo(StoredFile, 'Файл').getByIds(fileIds);
    if (files.some((f) => !f.mime.startsWith('image/'))) throw Errors.bad('NOT_IMAGE', 'Фото должно быть картинкой');
    await tx.repo(ProductPhoto).hardDelete({ productId });
    await tx.repo(ProductPhoto).insertMany(fileIds.map((fileId, i) => ({ productId, fileId, sort: i })));
    await tx.query(
      `UPDATE files SET entity_type = 'product', entity_id = $2 WHERE tenant_id = $1 AND id = ANY($3::uuid[])`,
      [tx.tenantId, productId, fileIds],
    );
  }

  async updatePhotos(productId: string, fileIds: string[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      await this.setPhotos(tx, productId, fileIds);
      await this.audit.log(tx, { action: 'product.photos', entityType: 'product', entityId: productId, after: { fileIds } });
      return tx.repo(ProductPhoto).find({ where: { productId }, order: { sort: 'ASC' } });
    });
  }

  private async setKit(tx: TenantTx, kit: Product, items: { productId: string; qty: string }[]) {
    if (kit.kind !== 'kit') throw Errors.bad('NOT_KIT', 'Состав задаётся только у комплекта');
    const comps = await tx.repo(Product, 'Компонент').getByIds(items.map((i) => i.productId));
    for (const c of comps) {
      if (c.id === kit.id) throw Errors.bad('KIT_SELF', 'Комплект не может входить в себя');
      if (c.kind !== 'goods') throw Errors.bad('KIT_COMPONENT', `«${c.name}»: в комплект входят только обычные товары`);
    }
    await tx.repo(KitComponent).hardDelete({ kitId: kit.id });
    await tx.repo(KitComponent).insertMany(
      items.map((i) => {
        const q = qty(i.qty);
        if (q.lte(0)) throw Errors.bad('BAD_QTY', 'Количество в комплекте должно быть больше нуля');
        return { kitId: kit.id, componentId: i.productId, qty: q };
      }),
    );
  }

  async setPrices(productId: string, items: { priceTypeId: string; storeId?: string; unitId?: string; price: string; currency?: string }[]) {
    return this.tenantTx.run(async (tx) => {
      const p = await tx.repo(Product, 'Товар').getById(productId);
      for (const i of items) {
        if (i.unitId) {
          const u = await tx.repo(ProductUnit, 'Единица').getById(i.unitId);
          if (u.productId !== p.id) throw Errors.notFound('Единица');
        }
        if (i.storeId && !this.canStore(i.storeId)) throw Errors.notFound('Точка');
      }
      await this.prices.set(tx, items.map((i) => ({ ...i, productId })));
      return this.prices.current(tx, [productId]);
    });
  }

  private canStore(storeId: string) {
    const ids = this.ctx.get('storeIds');
    return ids === null || ids === undefined || ids.includes(storeId);
  }

  // ── Номера ──────────────────────────────────────────────

  /**
   * Заменить номер производителя и OEM-номера. У «Без бренда» основной номер — копируемый OEM (ТЗ 4.2),
   * поэтому он хранится как oem и не конфликтует с другими копиями.
   */
  async replaceNumbers(tx: TenantTx, p: Product, brand: Brand | null, main: string | null | undefined, oem: string[] | null | undefined) {
    await tx.repo(PartNumber).hardDelete({ productId: p.id, type: 'manufacturer' });
    await tx.repo(PartNumber).hardDelete({ productId: p.id, type: 'oem' });
    const rows: Partial<PartNumber>[] = [];
    const seen = new Set<string>();
    const push = (number: string, type: 'manufacturer' | 'oem', brandId: string | null) => {
      const normalized = normalizePartNumber(number);
      if (!normalized) return;
      const k = `${type}:${normalized}`;
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({ productId: p.id, number: number.trim(), normalized, skeleton: partNumberSkeleton(normalized), type, brandId });
    };
    if (main) {
      if (!brand || brand.isNoBrand) push(main, 'oem', null);
      else {
        await this.assertNumberFree(tx, brand, main, p.id);
        push(main, 'manufacturer', brand.id);
      }
    }
    for (const o of oem ?? []) push(o, 'oem', null);
    await tx.repo(PartNumber).insertMany(rows);
  }

  private async assertNumberFree(tx: TenantTx, brand: Brand, number: string, exceptProductId: string | null) {
    const normalized = normalizePartNumber(number);
    if (!normalized) throw Errors.bad('BAD_NUMBER', 'Пустой номер детали');
    const dup = await tx.query<{ id: string; name: string; sku: string }>(
      `SELECT p.id, p.name, p.sku FROM part_numbers n JOIN products p ON p.id = n.product_id AND p.deleted_at IS NULL
        WHERE n.tenant_id = $1 AND n.type = 'manufacturer' AND n.brand_id = $2 AND n.normalized = $3
          AND ($4::uuid IS NULL OR n.product_id <> $4)`,
      [tx.tenantId, brand.id, normalized, exceptProductId],
    );
    if (dup.length) {
      throw Errors.conflict('DUPLICATE_PART_NUMBER', `${brand.name} ${number} уже есть: ${dup[0].sku} ${dup[0].name}`, {
        product: dup[0],
      });
    }
  }

  // ── Вспомогательное ────────────────────────────────────

  private async pickBrand(tx: TenantTx, dto: { brand?: string; brandId?: string }): Promise<Brand | null> {
    if (dto.brandId) return tx.repo(Brand, 'Бренд').getById(dto.brandId);
    if (dto.brand) return this.brands.resolve(tx, dto.brand, true);
    return null;
  }

  async baseUnit(tx: TenantTx, productId: string) {
    const u = await tx.repo(ProductUnit).findOne({ where: { productId, isBase: true } });
    if (!u) throw new Error('У товара нет базовой единицы');
    return u;
  }

  private async nextSku(tx: TenantTx) {
    for (let i = 0; i < 20; i++) {
      const sku = String(await this.counters.next(tx, 'product.sku')).padStart(6, '0');
      if (!(await tx.repo(Product).count({ where: { sku }, withDeleted: true }))) return sku;
    }
    throw new Error('Не удалось подобрать артикул');
  }

  private async categoryNoStockControl(tx: TenantTx, categoryId?: string | null) {
    if (!categoryId) return false;
    return !!(await this.categories.effectiveSettings(tx, categoryId)).noStockControl;
  }

  private validateKindFlags(kind: string, dto: { isSerial?: boolean; fractional?: boolean }) {
    if (kind !== 'goods' && dto.isSerial) throw Errors.bad('BAD_FLAGS', 'Серийный учёт — только у обычного товара');
    if (kind === 'kit' && dto.fractional) throw Errors.bad('BAD_FLAGS', 'Комплект не бывает дробным');
  }

  /** Проверка значений атрибутов по типу детали (ТЗ 4.5). */
  async validateAttributes(tx: TenantTx, partTypeId: string | null, values: Record<string, unknown>, enforceRequired: boolean) {
    const defs: Attribute[] = await this.partTypes.attributesFor(tx, partTypeId);
    const out: Record<string, unknown> = {};
    const errors: { field: string; message: string }[] = [];
    for (const [code, raw] of Object.entries(values)) {
      const def = defs.find((d) => d.code === code);
      if (!def) {
        errors.push({ field: code, message: 'Нет такого атрибута у этого типа детали' });
        continue;
      }
      if (raw === null || raw === '' || raw === undefined) continue;
      switch (def.valueType) {
        case 'number': {
          const n = Number(String(raw).replace(',', '.'));
          if (!Number.isFinite(n)) errors.push({ field: code, message: `${def.name}: нужно число` });
          else out[code] = n;
          break;
        }
        case 'boolean':
          out[code] = raw === true || raw === 'true' || raw === 'да' || raw === 1;
          break;
        case 'list':
          if (!def.options.includes(String(raw))) errors.push({ field: code, message: `${def.name}: выберите из списка (${def.options.join(', ')})` });
          else out[code] = String(raw);
          break;
        case 'size': {
          const parts = Array.isArray(raw) ? raw : String(raw).split(/[x×х*\s/]+/i).filter(Boolean);
          const nums = parts.map((v) => Number(String(v).replace(',', '.')));
          if (nums.length !== def.options.length || nums.some((v) => !Number.isFinite(v))) {
            errors.push({ field: code, message: `${def.name}: ${def.options.join(' × ')}` });
          } else out[code] = nums;
          break;
        }
        default:
          out[code] = String(raw).trim().slice(0, 300);
      }
    }
    if (enforceRequired && partTypeId) {
      for (const d of defs.filter((x) => x.required && x.partTypeId)) {
        if (out[d.code] === undefined) errors.push({ field: d.code, message: `${d.name}: обязательный атрибут` });
      }
    }
    if (errors.length) throw Errors.bad('ATTRIBUTES_INVALID', 'Проверьте атрибуты', errors);
    return out;
  }
}

function strip(card: any) {
  const { attributeDefs: _a, stock: _s, prices: _p, ...rest } = card;
  return rest;
}

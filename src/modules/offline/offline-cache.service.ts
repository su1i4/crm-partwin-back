import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { PIN_OFFLINE, pinOfflineSalt } from '../pos/pin.service';
import { SettingsService } from '../settings/settings.service';
import { Register } from '../stores/entities/register.entity';
import { Store } from '../stores/entities/store.entity';
import { DeviceContext, PosDevicesService } from './pos-devices.service';

/** Запас по времени курсора: записи, закоммиченные во время выгрузки, придут повторно (касса сливает по id). */
const OVERLAP_SEC = 10;

/**
 * Данные для кэша кассы (ТЗ 16.3): полная выгрузка при входе и раз в сутки, изменения по курсору каждые 1–5 минут.
 * Товары — с остатком на складах точки или с продажами за 90 дней (лимит из настроек), штрихкоды, номера, аналоги,
 * цены точки (включая будущие), курс, остатки, клиенты, сотрудники точки с хэшами PIN, счета, чеки за 30 дней.
 */
@Injectable()
export class OfflineCacheService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly devices: PosDevicesService,
    private readonly settings: SettingsService,
  ) {}

  async build(token: string | undefined, cursor?: string | null) {
    const dc = await this.devices.authenticate(token);
    if (cursor !== undefined && cursor !== null && isNaN(Date.parse(cursor))) throw Errors.bad('BAD_CURSOR', 'Неверный курсор');
    return this.devices.runAs(dc, null, () =>
      this.tenantTx.run(async (tx) => {
        const [{ now }] = await tx.query(`SELECT now() AS now`);
        const since = cursor ? new Date(Date.parse(cursor)) : null;
        const data = await this.collect(tx, dc, since);
        await tx.query(`UPDATE devices SET last_sync_at = now() WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, dc.device.id]);
        return {
          full: !since,
          serverTime: now,
          cursor: new Date(new Date(now).getTime() - OVERLAP_SEC * 1000).toISOString(),
          ...data,
        };
      }),
    );
  }

  private async collect(tx: TenantTx, dc: DeviceContext, since: Date | null) {
    const t = tx.tenantId;
    const storeId = dc.device.storeId;
    const reg = await tx.repo(Register, 'Касса').getById(dc.device.registerId);
    const store = await tx.repo(Store, 'Точка').getById(storeId);
    const s = await this.settings.get(tx);
    const single = store.registerMode === 'single';
    const sinceSql = (col: string, n: number) => (since ? `AND ${col} > $${n}` : '');
    const sp = since ? [since] : [];

    // ── Товары: остаток на складах точки или продажи за 90 дней; лимит — настройка
    const selected = `
      SELECT p.id FROM products p
       WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.status = 'active' AND p.merged_into_id IS NULL
         AND (EXISTS (SELECT 1 FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
                       WHERE b.tenant_id = p.tenant_id AND b.product_id = p.id AND w.store_id = $2 AND b.qty <> 0)
           OR EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
                       WHERE l.tenant_id = p.tenant_id AND l.product_id = p.id AND d.type = 'sale' AND d.status = 'posted'
                         AND d.store_id = $2 AND d.doc_date > now() - interval '90 days')
           OR p.kind IN ('service', 'kit') OR p.no_stock_control)
       ORDER BY (SELECT coalesce(sum(b.qty), 0) FROM stock_balances b WHERE b.tenant_id = p.tenant_id AND b.product_id = p.id) DESC, p.id
       LIMIT ${Number(s.offlineProductLimit) || 50000}`;
    const ids: string[] = (await tx.query(selected, [t, storeId])).map((r: any) => r.id);
    const prodSince = since ? `AND (p.updated_at > $3 OR EXISTS (SELECT 1 FROM product_units u WHERE u.product_id = p.id AND u.updated_at > $3))` : '';
    const products = await tx.query(
      `SELECT p.id, p.name, p.sku, p.kind, p.brand_id AS "brandId", b.name AS "brandName", p.category_id AS "categoryId", p.quality_class AS "qualityClass",
              p.base_unit AS "baseUnit", p.fractional, p.qty_step AS "qtyStep", p.is_serial AS "isSerial", p.no_stock_control AS "noStockControl",
              p.price_negotiable AS "priceNegotiable", p.min_price AS "minPrice", p.recommended_price AS "recommendedPrice", p.warranty_days AS "warrantyDays",
              p.return_days AS "returnDays", p.attributes, p.search_text AS "searchText", p.version,
              (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'factor', u.factor, 'isBase', u.is_base, 'priceMode', u.price_mode))
                 FROM product_units u WHERE u.tenant_id = p.tenant_id AND u.product_id = p.id AND u.deleted_at IS NULL) AS units,
              (SELECT json_agg(json_build_object('componentId', k.component_id, 'qty', k.qty)) FROM kit_components k WHERE k.tenant_id = p.tenant_id AND k.kit_id = p.id) AS "kitComponents"
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[]) ${prodSince}`,
      [t, ids, ...sp],
    );
    const barcodes = await tx.query(
      `SELECT product_id AS "productId", unit_id AS "unitId", barcode FROM product_barcodes WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) ${sinceSql('created_at', 3)}`,
      [t, ids, ...sp],
    );
    const numbers = await tx.query(
      `SELECT product_id AS "productId", number, normalized, skeleton, type, brand_id AS "brandId" FROM part_numbers
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) ${sinceSql('updated_at', 3)}`,
      [t, ids, ...sp],
    );
    // Аналоги между номерами кэшированных товаров
    const crosses = await tx.query(
      `SELECT c.a_normalized AS a, c.b_normalized AS b, c.cross_type AS "crossType" FROM part_crosses c
        WHERE c.tenant_id = $1 ${sinceSql('c.updated_at', 3)}
          AND EXISTS (SELECT 1 FROM part_numbers n WHERE n.tenant_id = c.tenant_id AND n.product_id = ANY($2::uuid[]) AND n.normalized IN (c.a_normalized, c.b_normalized))
        LIMIT 200000`,
      [t, ids, ...sp],
    );
    // Цены точки и «для всех точек»: действующие и будущие
    const prices = await tx.query(
      `SELECT x.product_id AS "productId", x.price_type_id AS "priceTypeId", x.store_id AS "storeId", x.unit_id AS "unitId", x.price, x.currency, x.valid_from AS "validFrom"
         FROM (SELECT DISTINCT ON (product_id, price_type_id, store_id, unit_id) * FROM prices
                WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND (store_id IS NULL OR store_id = $3) AND valid_from <= now()
                ORDER BY product_id, price_type_id, store_id, unit_id, valid_from DESC, created_at DESC) x
        WHERE true ${since ? 'AND x.created_at > $4' : ''}
       UNION ALL
       SELECT product_id, price_type_id, store_id, unit_id, price, currency, valid_from FROM prices
        WHERE tenant_id = $1 AND product_id = ANY($2::uuid[]) AND (store_id IS NULL OR store_id = $3) AND valid_from > now() ${since ? 'AND created_at > $4' : ''}`,
      [t, ids, storeId, ...sp],
    );
    const stock = await tx.query(
      `SELECT b.warehouse_id AS "warehouseId", b.product_id AS "productId", b.qty FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.tenant_id = $1 AND w.store_id = $2 AND b.product_id = ANY($3::uuid[]) ${sinceSql('b.updated_at', 4)}`,
      [t, storeId, ids, ...sp],
    );
    const removedProducts = since
      ? (await tx.query(
          `SELECT id FROM products WHERE tenant_id = $1 AND updated_at > $2 AND (deleted_at IS NOT NULL OR status <> 'active' OR merged_into_id IS NOT NULL)
           UNION SELECT id FROM products WHERE tenant_id = $1 AND deleted_at > $2`,
          [t, since],
        )).map((r: any) => r.id)
      : [];

    // ── Справочники
    const priceTypes = await tx.query(`SELECT id, name, code, currency, is_retail AS "isRetail" FROM price_types WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY sort`, [t]);
    const rates = await tx.query(`SELECT DISTINCT ON (currency) currency, rate, created_at AS "setAt" FROM shop_rates WHERE tenant_id = $1 ORDER BY currency, created_at DESC`, [t]);
    const categories = await tx.query(`SELECT id, parent_id AS "parentId", name, path, settings FROM categories WHERE tenant_id = $1 AND deleted_at IS NULL ${sinceSql('updated_at', 2)}`, [t, ...sp]);
    const groups = await tx.query(
      `SELECT id, name, price_type_id AS "priceTypeId", discount_percent AS "discountPercent", debt_limit AS "debtLimit", debt_days AS "debtDays"
         FROM counterparty_groups WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [t],
    );
    // Клиенты: для «одной кассы» — долг на момент синхронизации (для продажи в долг без сети)
    const customers = await tx.query(
      `SELECT c.id, c.name, c.phone, c.phones, c.group_id AS "groupId", c.price_type_id AS "priceTypeId", c.discount_percent AS "discountPercent",
              c.debt_limit AS "debtLimit", c.roles, c.version
              ${single ? `, (SELECT coalesce(sum(d.remaining), 0) FROM debt_items d WHERE d.tenant_id = c.tenant_id AND d.counterparty_id = c.id AND d.direction = 'receivable' AND d.currency = 'KGS') AS debt` : ''}
         FROM counterparties c WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
          AND (c.roles && ARRAY['customer','sto','master','neighbor']::text[]) ${sinceSql('c.updated_at', 2)}
        ORDER BY c.updated_at DESC LIMIT 20000`,
      [t, ...sp],
    );
    const vehicles = await tx.query(
      `SELECT id, counterparty_id AS "counterpartyId", title, plate, vin FROM customer_vehicles WHERE tenant_id = $1 AND deleted_at IS NULL ${sinceSql('updated_at', 2)} LIMIT 50000`,
      [t, ...sp],
    );
    // Сотрудники точки: PIN — HMAC(секрет устройства, PBKDF2(PIN)), без самого PIN
    const staff = (
      await tx.query(
        `SELECT m.id AS "membershipId", u.name, m.is_owner AS "isOwner", m.status, m.pin_offline_hash AS h
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND (m.is_owner OR m.all_stores OR EXISTS (SELECT 1 FROM membership_store_access a WHERE a.membership_id = m.id AND a.store_id = $2))`,
        [t, storeId],
      )
    ).map((m: any) => ({
      membershipId: m.membershipId,
      name: m.name,
      isOwner: m.isOwner,
      active: m.status === 'active',
      pinHash: m.status === 'active' ? this.devices.wrapPinHash(dc.device, m.h) : null,
    }));
    for (const m of staff) {
      const a = await tx.query(
        `SELECT DISTINCT rp.permission FROM membership_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
          WHERE mr.tenant_id = $1 AND mr.membership_id = $2`,
        [t, m.membershipId],
      );
      const [d] = await tx.query(
        `SELECT coalesce(max((r.settings->>'maxDiscountPercent')::numeric), 0) AS max FROM membership_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.tenant_id = $1 AND mr.membership_id = $2`,
        [t, m.membershipId],
      );
      (m as any).permissions = m.isOwner ? ['*'] : a.map((x: any) => x.permission);
      (m as any).maxDiscountPercent = m.isOwner ? 100 : Number(d.max);
    }
    const accounts = await tx.query(
      `SELECT id, type, name, currency, register_id AS "registerId", holder_membership_id AS "holderMembershipId", details
         FROM money_accounts WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active AND (store_id IS NULL OR store_id = $2)
          AND (type <> 'cash' OR register_id = $3) AND type IN ('cash', 'wallet', 'acquiring', 'bank')`,
      [t, storeId, reg.id],
    );
    // Чеки за 30 дней: кассы (для «одной кассы» — всей точки) — для возвратов без сети
    const receipts = await tx.query(
      `SELECT r.id, r.number, r.kind, r.register_id AS "registerId", r.customer_id AS "customerId", r.total, r.completed_at AS "completedAt", r.public_token AS "publicToken",
              (SELECT json_agg(json_build_object('id', l.id, 'productId', l.product_id, 'unitId', l.unit_id, 'qty', l.qty, 'price', l.price, 'amount', l.amount,
                                                 'name', coalesce(l.extra->>'name', ''), 'serialItemIds', l.serial_item_ids, 'rules', l.extra->'rules') ORDER BY l.line_no)
                 FROM document_lines l WHERE l.tenant_id = r.tenant_id AND l.document_id = r.document_id) AS lines,
              (SELECT json_agg(json_build_object('method', p.method, 'currency', p.currency, 'amount', p.amount, 'amountKgs', p.amount_kgs, 'accountId', p.account_id))
                 FROM receipt_payments p WHERE p.tenant_id = r.tenant_id AND p.receipt_id = r.id) AS payments
         FROM receipts r
        WHERE r.tenant_id = $1 AND r.status = 'completed' AND r.completed_at > now() - interval '30 days'
          AND ((${single ? 'true' : 'false'} AND r.store_id = $2) OR r.register_id = $3) ${since ? 'AND r.updated_at > $4' : ''}
        ORDER BY r.completed_at DESC LIMIT 20000`,
      [t, storeId, reg.id, ...sp],
    );
    const warehouses = await tx.query(`SELECT id, name, type FROM warehouses WHERE tenant_id = $1 AND store_id = $2 AND deleted_at IS NULL AND is_active`, [t, storeId]);
    const [lastNumber] = await tx.query(
      `SELECT max(number) AS n FROM receipts WHERE tenant_id = $1 AND device_id = $2 AND number LIKE $3`,
      [t, dc.device.id, `${reg.code}${dc.device.series}-%`],
    );

    return {
      device: { id: dc.device.id, series: dc.device.series, numberPrefix: `${reg.code}${dc.device.series}`, lastNumber: lastNumber?.n ?? null, lastOpSeq: dc.device.lastOpSeq },
      store: { id: store.id, name: store.name, code: store.code, timezone: store.timezone, registerMode: store.registerMode, address: store.address, phone: store.phone },
      register: { id: reg.id, code: reg.code, name: reg.name, warehouseId: reg.warehouseId },
      // Что можно без интернета (ТЗ 16.2): касса берёт правила отсюда
      offlineRules: offlineRules(single),
      settings: {
        priceRounding: s.priceRounding,
        negativeStock: s.negativeStock,
        belowCostSale: s.belowCostSale,
        allowFreeItems: s.allowFreeItems,
        allowQuickCreateAtPos: s.allowQuickCreateAtPos,
        deleteLineRequiresPin: s.deleteLineRequiresPin,
        cashHandover: s.cashHandover,
        repeatScanIncrements: s.repeatScanIncrements,
        quickBanknotes: s.quickBanknotes,
        minPriceCipher: s.minPriceCipher,
        offlineProductLimit: s.offlineProductLimit,
      },
      pin: { algorithm: 'pbkdf2-sha256', ...PIN_OFFLINE, salt: 'pin:{tenantId}:{membershipId}', wrap: 'hmac-sha256(deviceSecret, base64(pbkdf2))', tenantId: tx.tenantId, example: pinOfflineSalt('{tenantId}', '{membershipId}') },
      rates,
      priceTypes,
      categories,
      warehouses,
      products,
      productIds: since ? undefined : ids,
      removed: { products: removedProducts },
      barcodes,
      numbers,
      crosses,
      prices,
      stock,
      groups,
      customers,
      vehicles,
      staff,
      accounts,
      receipts,
    };
  }
}

/** Правила работы без интернета по режиму точки (ТЗ 16.2). */
export function offlineRules(single: boolean) {
  return {
    cash: true,
    card: true,
    transfer: true,
    debt: single,
    bonuses: single,
    serial: single,
    reserved: single,
    returnOwnRegister: true,
    returnOtherRegisterOrWithoutReceipt: single,
    promotions: true,
    oneTimePromocode: false,
    neighbor: true,
    createProduct: single ? 'draft' : 'free_item_only',
    newCustomer: true,
    shift: true,
    ocr: false,
  };
}

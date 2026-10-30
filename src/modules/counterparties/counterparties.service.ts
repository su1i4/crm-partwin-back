import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { D } from '../../common/utils/decimal';
import { normalizePhone } from '../../common/utils/login';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { PriceType } from '../pricing/entities/price-type.entity';
import {
  COUNTERPARTY_ROLES,
  Counterparty,
  CounterpartyContact,
  CounterpartyGroup,
  CounterpartyRole,
  CustomerVehicle,
} from './entities/counterparty.entity';

export interface CounterpartyInput {
  name?: string;
  kind?: 'person' | 'company';
  phone?: string | null;
  phones?: string[];
  inn?: string | null;
  address?: string | null;
  roles?: CounterpartyRole[];
  messengers?: Record<string, string>;
  supplierTerms?: Record<string, any>;
  note?: string | null;
  tags?: string[];
  groupId?: string | null;
  birthday?: string | null;
  priceTypeId?: string | null;
  discountPercent?: string | null;
  debtLimit?: string | null;
  debtDays?: number | null;
  confirmDuplicatePhone?: boolean;
}

export interface CounterpartyListQuery {
  role?: string;
  q?: string;
  groupId?: string;
  /** Сегменты (ТЗ 18.1): не покупал N дней, купил больше суммы, владельцы марки, есть долг */
  noPurchaseDays?: number;
  minTotal?: string;
  makeId?: string;
  hasDebt?: boolean;
  page: number;
  limit: number;
}

export interface VehicleInput {
  makeId?: string | null;
  modelId?: string | null;
  generationId?: string | null;
  modificationId?: string | null;
  title?: string;
  vin?: string | null;
  bodyCode?: string | null;
  year?: number | null;
  plate?: string | null;
  mileage?: number | null;
  note?: string | null;
}

/** Условия клиента: свои или из группы (ТЗ 18.1, 18.2). */
export interface CustomerTerms {
  priceTypeId: string | null;
  discountPercent: string;
  /** null — без лимита */
  debtLimit: string | null;
  debtDays: number | null;
  groupName: string | null;
}

export const DEFAULT_GROUPS = [
  { name: 'Розница', priceTypeCode: 'retail', discountPercent: '0', debtLimit: '0', debtDays: null, sort: 1 },
  { name: 'СТО', priceTypeCode: 'sto', discountPercent: '0', debtLimit: null, debtDays: 30, sort: 2 },
  { name: 'Таксопарки', priceTypeCode: 'sto', discountPercent: '0', debtLimit: null, debtDays: 30, sort: 3 },
  { name: 'Оптовики', priceTypeCode: 'wholesale', discountPercent: '0', debtLimit: null, debtDays: 14, sort: 4 },
  { name: 'Мастера', priceTypeCode: 'sto', discountPercent: '0', debtLimit: '0', debtDays: null, sort: 5 },
];

export const normalizePlate = (p?: string | null) => (p ? p.toUpperCase().replace(/[^0-9A-ZА-Я]/g, '').slice(0, 20) || null : null);

/** Контрагенты — один справочник с ролями (ТЗ 18.1), группы, контакты, гараж (ТЗ 6.4), дубли и объединение. */
@Injectable()
export class CounterpartiesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
  ) {}

  // ── Список и карточка ────────────────────────────────────

  async list(q: CounterpartyListQuery) {
    return this.tenantTx.run(async (tx) => {
      const params: unknown[] = [tx.tenantId];
      const p = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const w = ['c.tenant_id = $1', 'c.deleted_at IS NULL'];
      if (q.role) w.push(`c.roles @> ${p([q.role])}::text[]`);
      if (q.groupId) w.push(`c.group_id = ${p(q.groupId)}`);
      if (q.q) {
        const digits = normalizePhone(q.q) ?? q.q.replace(/\D/g, '');
        const like = p(`%${q.q}%`);
        const ph = p(digits);
        const plate = p(normalizePlate(q.q) ?? '');
        w.push(`(c.name ILIKE ${like} OR (${ph} <> '' AND (c.phone LIKE '%' || ${ph} || '%' OR EXISTS (SELECT 1 FROM unnest(c.phones) x WHERE x LIKE '%' || ${ph} || '%')))
                 OR (${plate} <> '' AND EXISTS (SELECT 1 FROM customer_vehicles v WHERE v.tenant_id = c.tenant_id AND v.counterparty_id = c.id AND v.deleted_at IS NULL AND v.plate LIKE ${plate} || '%')))`);
      }
      const stats = `(SELECT max(r.completed_at) AS last_visit,
                             coalesce(sum(CASE WHEN r.kind = 'sale' THEN r.total ELSE -r.total END), 0) AS total
                        FROM receipts r WHERE r.tenant_id = c.tenant_id AND r.customer_id = c.id AND r.status = 'completed')`;
      if (q.noPurchaseDays) w.push(`coalesce((SELECT max(r.completed_at) FROM receipts r WHERE r.tenant_id = c.tenant_id AND r.customer_id = c.id AND r.status = 'completed'), 'epoch') < now() - make_interval(days => ${p(q.noPurchaseDays)}::int)`);
      if (q.minTotal) w.push(`(SELECT coalesce(sum(CASE WHEN r.kind = 'sale' THEN r.total ELSE -r.total END), 0) FROM receipts r WHERE r.tenant_id = c.tenant_id AND r.customer_id = c.id AND r.status = 'completed') >= ${p(q.minTotal)}::numeric`);
      if (q.makeId) w.push(`EXISTS (SELECT 1 FROM customer_vehicles v WHERE v.tenant_id = c.tenant_id AND v.counterparty_id = c.id AND v.deleted_at IS NULL AND v.make_id = ${p(q.makeId)})`);
      if (q.hasDebt) w.push(`EXISTS (SELECT 1 FROM debt_items d WHERE d.tenant_id = c.tenant_id AND d.counterparty_id = c.id AND d.direction = 'receivable' AND d.remaining > 0)`);
      const where = w.join(' AND ');
      const [{ total }] = await tx.query(`SELECT count(*)::int AS total FROM counterparties c WHERE ${where}`, params);
      const items = await tx.query(
        `SELECT c.id, c.name, c.kind, c.phone, c.inn, c.roles, c.tags, c.group_id AS "groupId", g.name AS "groupName", c.version,
                s.last_visit AS "lastVisit", s.total AS "purchasesTotal",
                (SELECT coalesce(sum(d.remaining), 0) FROM debt_items d WHERE d.tenant_id = c.tenant_id AND d.counterparty_id = c.id
                   AND d.direction = 'receivable' AND d.currency = 'KGS') AS "debtKgs"
           FROM counterparties c LEFT JOIN counterparty_groups g ON g.id = c.group_id
           LEFT JOIN LATERAL ${stats} s ON true
          WHERE ${where} ORDER BY c.name LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total };
    });
  }

  get(id: string) {
    return this.tenantTx.repo(Counterparty, 'Контрагент').getById(id);
  }

  /** Карточка клиента: условия, покупки, средний чек, последний визит, долги по валютам и машинам, гараж, контакты. */
  card(id: string) {
    return this.tenantTx.run(async (tx) => {
      const c = await tx.repo(Counterparty, 'Контрагент').getById(id);
      const [stats] = await tx.query(
        `SELECT count(*) FILTER (WHERE kind = 'sale')::int AS "receiptsCount",
                coalesce(sum(CASE WHEN kind = 'sale' THEN total ELSE -total END), 0) AS "purchasesTotal",
                coalesce(avg(total) FILTER (WHERE kind = 'sale'), 0)::numeric(18,2) AS "averageReceipt",
                max(completed_at) AS "lastVisit"
           FROM receipts WHERE tenant_id = $1 AND customer_id = $2 AND status = 'completed'`,
        [tx.tenantId, id],
      );
      const debts = await tx.query(
        `SELECT direction, currency, sum(remaining) AS amount,
                sum(remaining) FILTER (WHERE due_date < current_date) AS overdue
           FROM debt_items WHERE tenant_id = $1 AND counterparty_id = $2 AND remaining > 0
          GROUP BY direction, currency`,
        [tx.tenantId, id],
      );
      const debtsByVehicle = await tx.query(
        `SELECT d.customer_vehicle_id AS "vehicleId", coalesce(v.title, d.vehicle_label, 'Без машины') AS title, v.plate, d.currency,
                sum(d.remaining) AS amount
           FROM debt_items d LEFT JOIN customer_vehicles v ON v.id = d.customer_vehicle_id
          WHERE d.tenant_id = $1 AND d.counterparty_id = $2 AND d.direction = 'receivable' AND d.remaining > 0
          GROUP BY 1, 2, 3, 4 ORDER BY 2`,
        [tx.tenantId, id],
      );
      const vehicles = await tx.repo(CustomerVehicle).find({ where: { counterpartyId: id }, order: { createdAt: 'ASC' } });
      const contacts = await tx.repo(CounterpartyContact).find({ where: { counterpartyId: id }, order: { createdAt: 'ASC' } });
      const group = c.groupId ? await tx.repo(CounterpartyGroup).findById(c.groupId) : null;
      return { ...c, group, terms: await this.terms(tx, c), stats, debts, debtsByVehicle, vehicles, contacts };
    });
  }

  /** Тип цены, скидка, лимит и срок долга: свои значения важнее группы. */
  async terms(tx: TenantTx, c: Counterparty | string): Promise<CustomerTerms> {
    const cp = typeof c === 'string' ? await tx.repo(Counterparty, 'Клиент').getById(c) : c;
    const g = cp.groupId ? await tx.repo(CounterpartyGroup).findById(cp.groupId) : null;
    return {
      priceTypeId: cp.priceTypeId ?? g?.priceTypeId ?? null,
      discountPercent: D(cp.discountPercent ?? g?.discountPercent ?? 0).toFixed(2),
      debtLimit: cp.debtLimit !== null ? cp.debtLimit.toFixed(2) : g ? (g.debtLimit?.toFixed(2) ?? null) : null,
      debtDays: cp.debtDays ?? g?.debtDays ?? null,
      groupName: g?.name ?? null,
    };
  }

  // ── Создание и изменение ─────────────────────────────────

  async create(dto: CounterpartyInput) {
    if (!dto.name?.trim()) throw Errors.bad('NAME_REQUIRED', 'Укажите имя или название');
    this.checkRoles(dto.roles);
    return this.tenantTx.run((tx) => this.createInTx(tx, dto));
  }

  async createInTx(tx: TenantTx, dto: CounterpartyInput) {
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) throw Errors.bad('BAD_PHONE', 'Некорректный телефон');
    if (phone && !dto.confirmDuplicatePhone) {
      const dup = await tx.repo(Counterparty).findOne({ where: { phone } });
      if (dup) throw Errors.conflict('DUPLICATE_PHONE', `С этим телефоном уже есть «${dup.name}»`, { id: dup.id });
    }
    await this.checkRefs(tx, dto);
    const c = await tx.repo(Counterparty).insert({
      name: dto.name!.trim(),
      kind: dto.kind ?? 'person',
      phone,
      phones: (dto.phones ?? []).map((p) => normalizePhone(p) ?? p),
      inn: dto.inn ?? null,
      address: dto.address ?? null,
      roles: dto.roles ?? ['customer'],
      messengers: dto.messengers ?? {},
      supplierTerms: dto.supplierTerms ?? {},
      note: dto.note ?? null,
      tags: dto.tags ?? [],
      groupId: dto.groupId ?? (await this.defaultGroupId(tx, dto.roles ?? ['customer'])),
      birthday: dto.birthday ?? null,
      priceTypeId: dto.priceTypeId ?? null,
      discountPercent: dto.discountPercent ?? null,
      debtLimit: dto.debtLimit !== undefined && dto.debtLimit !== null ? D(dto.debtLimit) : null,
      debtDays: dto.debtDays ?? null,
    });
    await this.audit.log(tx, { action: 'counterparty.create', entityType: 'counterparty', entityId: c.id, after: c });
    return c;
  }

  async update(id: string, version: number, dto: CounterpartyInput) {
    this.checkRoles(dto.roles);
    return this.tenantTx.run(async (tx) => {
      const before = await tx.repo(Counterparty, 'Контрагент').getById(id);
      await this.checkRefs(tx, dto);
      let phone: string | null | undefined = undefined;
      if (dto.phone !== undefined) {
        phone = dto.phone ? normalizePhone(dto.phone) : null;
        if (dto.phone && !phone) throw Errors.bad('BAD_PHONE', 'Некорректный телефон');
        if (phone && phone !== before.phone && !dto.confirmDuplicatePhone) {
          const dup = await tx.repo(Counterparty).findOne({ where: { phone } });
          if (dup && dup.id !== id) throw Errors.conflict('DUPLICATE_PHONE', `С этим телефоном уже есть «${dup.name}»`, { id: dup.id });
        }
      }
      const patch: Partial<Counterparty> = {
        name: dto.name?.trim(),
        kind: dto.kind,
        phone,
        phones: dto.phones?.map((p) => normalizePhone(p) ?? p),
        inn: dto.inn,
        address: dto.address,
        roles: dto.roles,
        messengers: dto.messengers,
        supplierTerms: dto.supplierTerms,
        note: dto.note,
        tags: dto.tags,
        groupId: dto.groupId,
        birthday: dto.birthday,
        priceTypeId: dto.priceTypeId,
        discountPercent: dto.discountPercent,
        debtLimit: dto.debtLimit === undefined ? undefined : dto.debtLimit === null ? null : D(dto.debtLimit),
        debtDays: dto.debtDays,
      };
      // null нужно сохранить явно (update пропускает только undefined)
      const saved = await tx.repo(Counterparty).update(id, patch, version);
      await this.audit.log(tx, { action: 'counterparty.update', entityType: 'counterparty', entityId: id, before, after: saved });
      return saved;
    });
  }

  private async checkRefs(tx: TenantTx, dto: CounterpartyInput) {
    if (dto.groupId) await tx.repo(CounterpartyGroup, 'Группа').getById(dto.groupId);
    if (dto.priceTypeId) await tx.repo(PriceType, 'Тип цены').getById(dto.priceTypeId);
    if (dto.discountPercent !== undefined && dto.discountPercent !== null && (D(dto.discountPercent).lt(0) || D(dto.discountPercent).gt(100))) {
      throw Errors.bad('BAD_DISCOUNT', 'Скидка от 0 до 100%');
    }
  }

  private checkRoles(roles?: string[]) {
    const bad = (roles ?? []).filter((r) => !(COUNTERPARTY_ROLES as readonly string[]).includes(r));
    if (bad.length) throw Errors.bad('BAD_ROLE', `Неизвестные роли: ${bad.join(', ')}`);
  }

  private async defaultGroupId(tx: TenantTx, roles: string[]) {
    const groups = await this.ensureGroups(tx);
    const name = roles.includes('sto') ? 'СТО' : roles.includes('master') ? 'Мастера' : roles.includes('customer') ? 'Розница' : null;
    return name ? (groups.find((g) => g.name === name)?.id ?? null) : null;
  }

  // ── Группы ───────────────────────────────────────────────

  /** Группы по умолчанию создаются при первом обращении (у магазинов, созданных до этапа 3). */
  async ensureGroups(tx: TenantTx): Promise<CounterpartyGroup[]> {
    const existing = await tx.repo(CounterpartyGroup).find({ order: { sort: 'ASC' }, withDeleted: true });
    if (existing.length) return existing.filter((g) => !g.deletedAt);
    const types = await tx.repo(PriceType).find();
    await tx.repo(CounterpartyGroup).insertMany(
      DEFAULT_GROUPS.map((g) => ({
        name: g.name,
        priceTypeId: types.find((t) => t.code === g.priceTypeCode)?.id ?? null,
        discountPercent: g.discountPercent,
        debtLimit: g.debtLimit === null ? null : D(g.debtLimit),
        debtDays: g.debtDays,
        sort: g.sort,
      })),
    );
    return tx.repo(CounterpartyGroup).find({ order: { sort: 'ASC' } });
  }

  listGroups() {
    return this.tenantTx.run((tx) => this.ensureGroups(tx));
  }

  createGroup(dto: { name: string; priceTypeId?: string | null; discountPercent?: string; debtLimit?: string | null; debtDays?: number | null; sort?: number }) {
    if (!dto.name?.trim()) throw Errors.bad('NAME_REQUIRED', 'Укажите название группы');
    return this.tenantTx.run(async (tx) => {
      await this.ensureGroups(tx);
      if (dto.priceTypeId) await tx.repo(PriceType, 'Тип цены').getById(dto.priceTypeId);
      if (await tx.repo(CounterpartyGroup).count({ where: { name: dto.name.trim() } })) throw Errors.conflict('DUPLICATE', 'Такая группа уже есть');
      const g = await tx.repo(CounterpartyGroup).insert({
        name: dto.name.trim(),
        priceTypeId: dto.priceTypeId ?? null,
        discountPercent: D(dto.discountPercent ?? 0).toFixed(2),
        debtLimit: dto.debtLimit === undefined || dto.debtLimit === null ? null : D(dto.debtLimit),
        debtDays: dto.debtDays ?? null,
        sort: dto.sort ?? 100,
      });
      await this.audit.log(tx, { action: 'counterparty_group.create', entityType: 'counterparty_group', entityId: g.id, summary: g.name });
      return g;
    });
  }

  updateGroup(id: string, version: number, dto: { name?: string; priceTypeId?: string | null; discountPercent?: string; debtLimit?: string | null; debtDays?: number | null; sort?: number }) {
    return this.tenantTx.run(async (tx) => {
      const g = await tx.repo(CounterpartyGroup, 'Группа').getForUpdate(id, version);
      const before = { ...g };
      if (dto.priceTypeId) await tx.repo(PriceType, 'Тип цены').getById(dto.priceTypeId);
      if (dto.name) g.name = dto.name.trim();
      if (dto.priceTypeId !== undefined) g.priceTypeId = dto.priceTypeId;
      if (dto.discountPercent !== undefined) g.discountPercent = D(dto.discountPercent).toFixed(2);
      if (dto.debtLimit !== undefined) g.debtLimit = dto.debtLimit === null ? null : D(dto.debtLimit);
      if (dto.debtDays !== undefined) g.debtDays = dto.debtDays;
      if (dto.sort !== undefined) g.sort = dto.sort;
      const saved = await tx.repo(CounterpartyGroup).save(g);
      await this.audit.log(tx, { action: 'counterparty_group.update', entityType: 'counterparty_group', entityId: g.id, before, after: saved, important: true });
      return saved;
    });
  }

  removeGroup(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      const g = await tx.repo(CounterpartyGroup, 'Группа').getForUpdate(id, version);
      const used = await tx.repo(Counterparty).count({ where: { groupId: id } });
      if (used) throw Errors.conflict('GROUP_USED', `В группе ${used} контрагентов — сначала переведите их в другую`);
      await tx.repo(CounterpartyGroup).softDelete(g.id);
    });
  }

  // ── Контакты ─────────────────────────────────────────────

  setContacts(id: string, contacts: { name: string; position?: string | null; phone?: string | null; note?: string | null }[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Counterparty, 'Контрагент').getById(id);
      await tx.repo(CounterpartyContact).hardDelete({ counterpartyId: id });
      if (contacts.length) {
        await tx.repo(CounterpartyContact).insertMany(
          contacts.map((c) => ({
            counterpartyId: id,
            name: c.name.trim(),
            position: c.position ?? null,
            phone: c.phone ? (normalizePhone(c.phone) ?? c.phone) : null,
            note: c.note ?? null,
          })),
        );
      }
      return tx.repo(CounterpartyContact).find({ where: { counterpartyId: id }, order: { createdAt: 'ASC' } });
    });
  }

  // ── Гараж (ТЗ 6.4) ───────────────────────────────────────

  vehicles(counterpartyId: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Counterparty, 'Контрагент').getById(counterpartyId);
      return tx.repo(CustomerVehicle).find({ where: { counterpartyId }, order: { createdAt: 'ASC' } });
    });
  }

  addVehicle(counterpartyId: string, dto: VehicleInput) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Counterparty, 'Контрагент').getById(counterpartyId);
      const v = await tx.repo(CustomerVehicle).insert({ counterpartyId, ...(await this.vehicleFields(tx, dto)) });
      await this.audit.log(tx, { action: 'vehicle.create', entityType: 'customer_vehicle', entityId: v.id, summary: v.title });
      return v;
    });
  }

  updateVehicle(id: string, version: number, dto: VehicleInput) {
    return this.tenantTx.run(async (tx) => {
      const v = await tx.repo(CustomerVehicle, 'Машина').getForUpdate(id, version);
      const merged = await this.vehicleFields(tx, {
        makeId: dto.makeId !== undefined ? dto.makeId : v.makeId,
        modelId: dto.modelId !== undefined ? dto.modelId : v.modelId,
        generationId: dto.generationId !== undefined ? dto.generationId : v.generationId,
        modificationId: dto.modificationId !== undefined ? dto.modificationId : v.modificationId,
        title: dto.title,
        vin: dto.vin !== undefined ? dto.vin : v.vin,
        bodyCode: dto.bodyCode !== undefined ? dto.bodyCode : v.bodyCode,
        year: dto.year !== undefined ? dto.year : v.year,
        plate: dto.plate !== undefined ? dto.plate : v.plate,
        mileage: dto.mileage !== undefined ? dto.mileage : v.mileage,
        note: dto.note !== undefined ? dto.note : v.note,
      });
      if (!dto.title && dto.makeId === undefined && dto.modelId === undefined && dto.generationId === undefined && dto.year === undefined) merged.title = v.title;
      Object.assign(v, merged);
      return tx.repo(CustomerVehicle).save(v);
    });
  }

  removeVehicle(id: string, version: number) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(CustomerVehicle, 'Машина').softDelete(id, version);
    });
  }

  /** История покупок по машине: чеки и строки. */
  vehicleHistory(id: string) {
    return this.tenantTx.run(async (tx) => {
      const v = await tx.repo(CustomerVehicle, 'Машина').getById(id);
      const rows = await tx.query(
        `SELECT r.id AS "receiptId", r.number, r.kind, r.completed_at AS "date", l.product_id AS "productId", p.name AS "productName",
                l.qty, l.amount, (SELECT string_agg(pn.number, ', ') FROM part_numbers pn WHERE pn.tenant_id = l.tenant_id AND pn.product_id = l.product_id AND pn.type = 'manufacturer') AS numbers
           FROM receipts r JOIN document_lines l ON l.tenant_id = r.tenant_id AND l.document_id = r.document_id
           JOIN products p ON p.id = l.product_id
          WHERE r.tenant_id = $1 AND r.customer_vehicle_id = $2 AND r.status = 'completed'
          ORDER BY r.completed_at DESC, l.line_no LIMIT 500`,
        [tx.tenantId, id],
      );
      return { vehicle: v, items: rows };
    });
  }

  private async vehicleFields(tx: TenantTx, dto: VehicleInput) {
    let title = dto.title?.trim();
    if (!title) {
      const parts: string[] = [];
      const name = async (sql: string, id?: string | null) => (id ? ((await tx.query(sql, [id, tx.tenantId]))[0]?.name as string | undefined) : undefined);
      parts.push((await name(`SELECT name FROM global_vehicle_makes WHERE id = $1 AND $2::uuid IS NOT NULL`, dto.makeId)) ?? '');
      parts.push(
        (await name(
          `SELECT name FROM global_vehicle_models WHERE id = $1 AND $2::uuid IS NOT NULL
           UNION ALL SELECT name FROM tenant_vehicle_models WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          dto.modelId,
        )) ?? '',
      );
      parts.push(
        (await name(
          `SELECT name FROM global_vehicle_generations WHERE id = $1 AND $2::uuid IS NOT NULL
           UNION ALL SELECT name FROM tenant_vehicle_generations WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          dto.generationId,
        )) ?? '',
      );
      if (dto.year) parts.push(String(dto.year));
      title = parts.filter(Boolean).join(' ');
    }
    if (!title) title = normalizePlate(dto.plate) ?? 'Машина';
    const vin = dto.vin ? dto.vin.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    if (vin && vin.length !== 17) throw Errors.bad('BAD_VIN', 'VIN — 17 символов');
    return {
      makeId: dto.makeId ?? null,
      modelId: dto.modelId ?? null,
      generationId: dto.generationId ?? null,
      modificationId: dto.modificationId ?? null,
      title: title.slice(0, 200),
      vin,
      bodyCode: dto.bodyCode?.toUpperCase().trim() || null,
      year: dto.year ?? null,
      plate: normalizePlate(dto.plate),
      mileage: dto.mileage ?? null,
      note: dto.note ?? null,
    };
  }

  // ── Дубли и объединение ──────────────────────────────────

  /** Возможные дубли: одинаковый телефон (основной или дополнительный). */
  duplicates() {
    return this.tenantTx.run(async (tx) => {
      return tx.query(
        `WITH ph AS (
           SELECT id, phone AS p FROM counterparties WHERE tenant_id = $1 AND deleted_at IS NULL AND phone IS NOT NULL
           UNION SELECT id, unnest(phones) FROM counterparties WHERE tenant_id = $1 AND deleted_at IS NULL)
         SELECT ph.p AS phone, json_agg(json_build_object('id', c.id, 'name', c.name, 'roles', c.roles) ORDER BY c.created_at) AS items
           FROM ph JOIN counterparties c ON c.id = ph.id
          GROUP BY ph.p HAVING count(DISTINCT ph.id) > 1 LIMIT 200`,
        [tx.tenantId],
      );
    });
  }

  /** Объединить дубли в основную карточку: документы, чеки, долги, гараж, контакты переходят к основной. */
  merge(mainId: string, duplicateIds: string[]) {
    return this.tenantTx.run(async (tx) => {
      const ids = duplicateIds.filter((x) => x !== mainId);
      if (!ids.length) throw Errors.bad('NOTHING_TO_MERGE', 'Выберите дубли');
      const main = await tx.repo(Counterparty, 'Контрагент').getForUpdate(mainId);
      const dups = await tx.repo(Counterparty, 'Контрагент').getByIds(ids);
      const t = tx.tenantId;
      const moves: [string, string][] = [
        ['documents', 'counterparty_id'],
        ['receipts', 'customer_id'],
        ['receipts', 'master_id'],
        ['debt_items', 'counterparty_id'],
        ['debt_payments', 'counterparty_id'],
        ['customer_vehicles', 'counterparty_id'],
        ['counterparty_contacts', 'counterparty_id'],
        ['neighbor_purchases', 'neighbor_id'],
        ['warranty_claims', 'customer_id'],
        ['warranty_claims', 'supplier_id'],
        ['money_movements', 'counterparty_id'],
      ];
      for (const [table, col] of moves) {
        await tx.query(`UPDATE ${table} SET ${col} = $2 WHERE tenant_id = $1 AND ${col} = ANY($3::uuid[])`, [t, mainId, ids]);
      }
      const phones = new Set([...main.phones, ...dups.flatMap((d) => [d.phone, ...d.phones])].filter((p): p is string => !!p && p !== main.phone));
      main.phones = [...phones];
      if (!main.phone) main.phone = dups.find((d) => d.phone)?.phone ?? null;
      if (main.phone) main.phones = main.phones.filter((p) => p !== main.phone);
      main.roles = [...new Set([...main.roles, ...dups.flatMap((d) => d.roles)])];
      main.tags = [...new Set([...main.tags, ...dups.flatMap((d) => d.tags)])];
      main.note = [main.note, ...dups.map((d) => d.note)].filter(Boolean).join('\n') || null;
      // Телефон дубля освобождаем до сохранения основной карточки
      await tx.query(`UPDATE counterparties SET merged_into_id = $2, phone = NULL, deleted_at = now(), version = version + 1 WHERE tenant_id = $1 AND id = ANY($3::uuid[])`, [t, mainId, ids]);
      await tx.repo(Counterparty).save(main);
      await this.audit.log(tx, {
        action: 'counterparty.merge',
        entityType: 'counterparty',
        entityId: mainId,
        summary: `Объединены в «${main.name}»: ${dups.map((d) => d.name).join(', ')}`,
        important: true,
      });
      return main;
    });
  }
}

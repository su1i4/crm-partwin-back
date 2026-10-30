import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { normalizeBrand } from '../../common/utils/brand';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { Brand, GlobalBrand } from './entities/brand.entity';

/**
 * Бренды (ТЗ 4.2): глобальный справочник + свои бренды магазина.
 * resolve() — найти по имени или синониму, при необходимости «подключить» глобальный или создать свой.
 */
@Injectable()
export class BrandsService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly audit: AuditService,
  ) {}

  async findTenantBrand(tx: TenantTx, name: string): Promise<Brand | null> {
    const norm = normalizeBrand(name);
    if (!norm) return null;
    const rows = await tx.query<{ id: string }>(
      `SELECT id FROM brands WHERE tenant_id = $1 AND deleted_at IS NULL AND (normalized_name = $2 OR $2 = ANY(aliases_norm))
       ORDER BY (normalized_name = $2) DESC LIMIT 1`,
      [tx.tenantId, norm],
    );
    return rows[0] ? tx.repo(Brand).findById(rows[0].id) : null;
  }

  async findGlobal(name: string): Promise<GlobalBrand | null> {
    const norm = normalizeBrand(name);
    if (!norm) return null;
    return this.platform
      .repo(GlobalBrand)
      .createQueryBuilder('g')
      .where('g.normalized_name = :n OR :n = ANY(g.aliases_norm)', { n: norm })
      .orderBy('(g.normalized_name = :n)', 'DESC')
      .getOne();
  }

  /** Подключить глобальный бренд магазину (идемпотентно). */
  async adoptGlobal(tx: TenantTx, g: GlobalBrand): Promise<Brand> {
    const existing = await tx.repo(Brand).findOne({ where: { globalBrandId: g.id } });
    if (existing) return existing;
    const byName = await tx.repo(Brand).findOne({ where: { normalizedName: g.normalizedName } });
    if (byName) {
      byName.globalBrandId = g.id;
      return tx.repo(Brand).save(byName);
    }
    return tx.repo(Brand).insert({
      name: g.name,
      normalizedName: g.normalizedName,
      globalBrandId: g.id,
      aliases: [],
      aliasesNorm: [],
      country: g.country,
      isCarMaker: g.isCarMaker,
      isNoBrand: g.isNoBrand,
    });
  }

  /**
   * Бренд по названию: свой → глобальный (подключаем) → создаём свой (если allowCreate).
   * «Bosch», «BOSCH», «Бош», «Robert Bosch» — один бренд.
   */
  async resolve(tx: TenantTx, name: string, allowCreate = true): Promise<Brand | null> {
    const clean = name?.trim();
    if (!clean) return null;
    const memoKey = `brand:${normalizeBrand(clean)}:${allowCreate}`;
    if (tx.memo.has(memoKey)) return tx.memo.get(memoKey) as Brand | null;
    const b = await this.resolveUncached(tx, clean, allowCreate);
    if (b) tx.memo.set(memoKey, b);
    return b;
  }

  private async resolveUncached(tx: TenantTx, clean: string, allowCreate: boolean): Promise<Brand | null> {
    const own = await this.findTenantBrand(tx, clean);
    if (own) return own;
    const g = await this.findGlobal(clean);
    if (g) return this.adoptGlobal(tx, g);
    if (!allowCreate) return null;
    return tx.repo(Brand).insert({
      name: clean.slice(0, 100),
      normalizedName: normalizeBrand(clean),
      aliases: [],
      aliasesNorm: [],
    });
  }

  async noBrand(tx: TenantTx): Promise<Brand> {
    const g = await this.platform.repo(GlobalBrand).findOne({ where: { isNoBrand: true } });
    if (!g) throw new Error('Нет системного бренда «Без бренда»');
    return this.adoptGlobal(tx, g);
  }

  /** Список для выбора: свои бренды + глобальные, ещё не подключённые. */
  async list(q?: string, limit = 50) {
    return this.tenantTx.run(async (tx) => {
      const norm = q ? normalizeBrand(q) : '';
      const own = await tx.query(
        `SELECT id, name, global_brand_id AS "globalBrandId", aliases, country, is_car_maker AS "isCarMaker",
                is_no_brand AS "isNoBrand", version, 'tenant' AS source
           FROM brands WHERE tenant_id = $1 AND deleted_at IS NULL
            AND ($2 = '' OR normalized_name LIKE $2 || '%' OR EXISTS (SELECT 1 FROM unnest(aliases_norm) a WHERE a LIKE $2 || '%'))
          ORDER BY name LIMIT $3`,
        [tx.tenantId, norm, limit],
      );
      const adopted = new Set(own.map((b: any) => b.globalBrandId).filter(Boolean));
      const global = await this.platform
        .repo(GlobalBrand)
        .createQueryBuilder('g')
        .where(`(:n = '' OR g.normalized_name LIKE :p OR EXISTS (SELECT 1 FROM unnest(g.aliases_norm) a WHERE a LIKE :p))`, {
          n: norm,
          p: `${norm}%`,
        })
        .orderBy('g.name')
        .limit(limit)
        .getMany();
      return [
        ...own,
        ...global
          .filter((g) => !adopted.has(g.id))
          .map((g) => ({
            id: null,
            globalBrandId: g.id,
            name: g.name,
            aliases: g.aliases,
            country: g.country,
            isCarMaker: g.isCarMaker,
            isNoBrand: g.isNoBrand,
            source: 'global',
          })),
      ].slice(0, limit);
    });
  }

  async create(dto: { name: string; aliases?: string[]; country?: string; globalBrandId?: string }) {
    return this.tenantTx.run(async (tx) => {
      if (dto.globalBrandId) {
        const g = await this.platform.repo(GlobalBrand).findOne({ where: { id: dto.globalBrandId } });
        if (!g) throw Errors.notFound('Бренд');
        return this.adoptGlobal(tx, g);
      }
      const norm = normalizeBrand(dto.name);
      if (!norm) throw Errors.bad('BAD_NAME', 'Укажите название бренда');
      const dup = await this.findTenantBrand(tx, dto.name);
      if (dup) throw Errors.conflict('BRAND_EXISTS', `Бренд уже есть: ${dup.name}`, { id: dup.id });
      const g = await this.findGlobal(dto.name);
      if (g) return this.adoptGlobal(tx, g);
      const aliases = (dto.aliases ?? []).map((a) => a.trim()).filter(Boolean);
      const brand = await tx.repo(Brand).insert({
        name: dto.name.trim(),
        normalizedName: norm,
        aliases,
        aliasesNorm: aliases.map(normalizeBrand),
        country: dto.country ?? null,
      });
      await this.audit.log(tx, { action: 'brand.create', entityType: 'brand', entityId: brand.id, after: brand });
      return brand;
    });
  }

  async update(id: string, dto: { version: number; name?: string; aliases?: string[]; country?: string }) {
    return this.tenantTx.run(async (tx) => {
      const b = await tx.repo(Brand, 'Бренд').getById(id);
      if (b.version !== dto.version) throw Errors.versionConflict();
      if (b.isNoBrand) throw Errors.forbidden('Системный бренд изменить нельзя');
      const before = { ...b };
      if (dto.name && !b.globalBrandId) {
        b.name = dto.name.trim();
        b.normalizedName = normalizeBrand(dto.name);
      }
      if (dto.aliases) {
        b.aliases = dto.aliases.map((a) => a.trim()).filter(Boolean);
        b.aliasesNorm = b.aliases.map(normalizeBrand);
      }
      if (dto.country !== undefined) b.country = dto.country;
      const saved = await tx.repo(Brand).save(b);
      await this.audit.log(tx, { action: 'brand.update', entityType: 'brand', entityId: id, before, after: saved });
      return saved;
    });
  }

  async remove(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const b = await tx.repo(Brand, 'Бренд').getById(id);
      if (b.version !== version) throw Errors.versionConflict();
      if (b.isNoBrand) throw Errors.forbidden('Системный бренд удалить нельзя');
      const [{ n }] = await tx.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND brand_id = $2 AND deleted_at IS NULL`, [tx.tenantId, id]);
      if (n) throw Errors.conflict('BRAND_IN_USE', `Бренд используется в ${n} товарах`);
      await tx.repo(Brand).softDelete(id);
      await this.audit.log(tx, { action: 'brand.delete', entityType: 'brand', entityId: id, before: b });
    });
  }
}

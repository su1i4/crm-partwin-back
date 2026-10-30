import { IsNull } from 'typeorm';
import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { Attribute, AttributeValueType, PartType } from './entities/part-type.entity';

export interface AttributeInput {
  name: string;
  code?: string;
  valueType: AttributeValueType;
  unit?: string | null;
  required?: boolean;
  filterable?: boolean;
  searchable?: boolean;
  options?: string[];
  sort?: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'attr';

/** Типы деталей и атрибуты (ТЗ 4.5). */
@Injectable()
export class PartTypesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.tenantTx.run(async (tx) => {
      const types = await tx.repo(PartType).find({ order: { sort: 'ASC', name: 'ASC' } });
      const attrs = await tx.repo(Attribute).find({ order: { sort: 'ASC' } });
      return {
        commonAttributes: attrs.filter((a) => !a.partTypeId),
        types: types.map((t) => ({ ...t, attributes: attrs.filter((a) => a.partTypeId === t.id) })),
      };
    });
  }

  /** Атрибуты, действующие для товара этого типа: общие + свои. */
  async attributesFor(tx: TenantTx, partTypeId: string | null): Promise<Attribute[]> {
    const attrs = await tx.repo(Attribute).find({ order: { sort: 'ASC' } });
    return attrs.filter((a) => !a.partTypeId || a.partTypeId === partTypeId);
  }

  async createType(dto: { name: string; code?: string; attributes?: AttributeInput[] }) {
    return this.tenantTx.run(async (tx) => {
      const code = dto.code ?? slug(dto.name);
      if (await tx.repo(PartType).count({ where: { code } })) throw Errors.conflict('CODE_TAKEN', 'Тип с таким кодом уже есть');
      const type = await tx.repo(PartType).insert({ name: dto.name.trim(), code, isSystem: false, sort: 1000 });
      for (const a of dto.attributes ?? []) await this.insertAttribute(tx, type.id, a);
      await this.audit.log(tx, { action: 'part_type.create', entityType: 'part_type', entityId: type.id, after: type });
      return type;
    });
  }

  async updateType(id: string, dto: { version: number; name?: string; sort?: number }) {
    return this.tenantTx.run(async (tx) => {
      const t = await tx.repo(PartType, 'Тип детали').getById(id);
      const saved = await tx.repo(PartType).update(id, { name: dto.name?.trim(), sort: dto.sort }, dto.version);
      await this.audit.log(tx, { action: 'part_type.update', entityType: 'part_type', entityId: id, before: t, after: saved });
      return saved;
    });
  }

  async removeType(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const t = await tx.repo(PartType, 'Тип детали').getById(id);
      if (t.version !== version) throw Errors.versionConflict();
      const [{ n }] = await tx.query(
        `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND part_type_id = $2 AND deleted_at IS NULL`,
        [tx.tenantId, id],
      );
      if (n) throw Errors.conflict('PART_TYPE_IN_USE', `Тип используется в ${n} товарах`);
      await tx.query(`UPDATE attributes SET deleted_at = now() WHERE tenant_id = $1 AND part_type_id = $2`, [tx.tenantId, id]);
      await tx.repo(PartType).softDelete(id);
      await this.audit.log(tx, { action: 'part_type.delete', entityType: 'part_type', entityId: id, before: t });
    });
  }

  async createAttribute(partTypeId: string | null, dto: AttributeInput) {
    return this.tenantTx.run(async (tx) => {
      if (partTypeId) await tx.repo(PartType, 'Тип детали').getById(partTypeId);
      const a = await this.insertAttribute(tx, partTypeId, dto);
      await this.audit.log(tx, { action: 'attribute.create', entityType: 'attribute', entityId: a.id, after: a });
      return a;
    });
  }

  private async insertAttribute(tx: TenantTx, partTypeId: string | null, dto: AttributeInput) {
    const code = dto.code ?? slug(dto.name);
    const dup = await tx.repo(Attribute).count({ where: { partTypeId: partTypeId ?? IsNull(), code } });
    if (dup) throw Errors.conflict('CODE_TAKEN', `Атрибут с кодом ${code} уже есть`);
    if ((dto.valueType === 'list' || dto.valueType === 'size') && !dto.options?.length) {
      throw Errors.bad('OPTIONS_REQUIRED', 'Для списка и размера укажите варианты / части');
    }
    return tx.repo(Attribute).insert({
      partTypeId,
      name: dto.name.trim(),
      code,
      valueType: dto.valueType,
      unit: dto.unit ?? null,
      required: !!dto.required,
      filterable: !!dto.filterable,
      searchable: !!dto.searchable,
      options: dto.options ?? [],
      sort: dto.sort ?? 1000,
    });
  }

  async updateAttribute(id: string, dto: Partial<AttributeInput> & { version: number }) {
    return this.tenantTx.run(async (tx) => {
      const a = await tx.repo(Attribute, 'Атрибут').getById(id);
      if (dto.valueType && dto.valueType !== a.valueType) {
        const [{ n }] = await tx.query(
          `SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND deleted_at IS NULL AND attributes ? $2`,
          [tx.tenantId, a.code],
        );
        if (n) throw Errors.conflict('ATTRIBUTE_IN_USE', `Тип значения нельзя менять: атрибут заполнен у ${n} товаров`);
      }
      const { code: _c, version, ...patch } = dto;
      const saved = await tx.repo(Attribute).update(id, patch, version);
      await this.audit.log(tx, { action: 'attribute.update', entityType: 'attribute', entityId: id, before: a, after: saved });
      return saved;
    });
  }

  async removeAttribute(id: string, version: number) {
    await this.tenantTx.run(async (tx) => {
      const a = await tx.repo(Attribute, 'Атрибут').getById(id);
      await tx.repo(Attribute).softDelete(id, version);
      await this.audit.log(tx, { action: 'attribute.delete', entityType: 'attribute', entityId: id, before: a });
    });
  }
}

import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { Product } from '../catalog/entities/product.entity';
import { SearchTextService } from '../catalog/search-text.service';
import { ApplicabilityInput, ApplicabilityService } from './applicability.service';
import { CreateTenantGenerationDto, CreateTenantModelDto } from './dto/vehicles.dto';
import { TenantVehicleGeneration, TenantVehicleModel } from './entities/vehicle.entity';
import { VehicleDirectoryService } from './vehicle-directory.service';

@Injectable()
export class VehiclesService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly dir: VehicleDirectoryService,
    private readonly app: ApplicabilityService,
    private readonly audit: AuditService,
    private readonly searchText: SearchTextService,
  ) {}

  async makes() {
    const g = await this.dir.global();
    return [...g.makes].sort((a, b) => Number(b.popular) - Number(a.popular) || a.sort - b.sort);
  }

  async models(makeId: string) {
    return this.tenantTx.run(async (tx) => (await this.dir.full(tx)).models.filter((m) => m.makeId === makeId));
  }

  async generations(modelId: string) {
    return this.tenantTx.run(async (tx) => (await this.dir.full(tx)).generations.filter((g) => g.modelId === modelId));
  }

  modifications(generationId: string) {
    return this.dir.modifications(generationId);
  }

  resolve(q: string) {
    return this.tenantTx.run(async (tx) => (await this.dir.resolve(tx, q, 8)).map(({ consumed: _c, ...r }) => r));
  }

  async createModel(dto: CreateTenantModelDto) {
    const g = await this.dir.global();
    if (!g.makes.some((m) => m.id === dto.makeId)) throw Errors.notFound('Марка');
    return this.tenantTx.run(async (tx) => {
      const m = await tx.repo(TenantVehicleModel).insert({ makeId: dto.makeId, name: dto.name.trim(), aliases: (dto.aliases ?? []).map((a) => a.toLowerCase()) });
      await this.audit.log(tx, { action: 'vehicle.model_create', entityType: 'vehicle_model', entityId: m.id, after: m });
      return m;
    });
  }

  async createGeneration(dto: CreateTenantGenerationDto) {
    return this.tenantTx.run(async (tx) => {
      const full = await this.dir.full(tx);
      if (!full.models.some((m) => m.id === dto.modelId)) throw Errors.notFound('Модель');
      const g = await tx.repo(TenantVehicleGeneration).insert({
        modelId: dto.modelId,
        name: dto.name.trim(),
        yearFrom: dto.yearFrom ?? null,
        yearTo: dto.yearTo ?? null,
        restyle: dto.restyle ?? null,
        aliases: (dto.aliases ?? []).map((a) => a.toLowerCase()),
        bodyCodes: (dto.bodyCodes ?? []).map((b) => b.toUpperCase()),
      });
      await this.audit.log(tx, { action: 'vehicle.generation_create', entityType: 'vehicle_generation', entityId: g.id, after: g });
      return g;
    });
  }

  // ── Применимость товара ─────────────────────────────────

  listApplicability(productId: string) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      return this.app.list(tx, productId);
    });
  }

  replaceApplicability(productId: string, items: ApplicabilityInput[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(productId);
      const before = await this.app.list(tx, productId);
      await this.app.replace(tx, productId, items);
      const after = await this.app.list(tx, productId);
      await this.audit.log(tx, {
        action: 'product.applicability',
        entityType: 'product',
        entityId: productId,
        before: { applicability: before.map((a) => a.label) },
        after: { applicability: after.map((a) => a.label) },
      });
      return after;
    });
  }

  bulkAdd(productIds: string[], items: ApplicabilityInput[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getByIds(productIds);
      const added = await this.app.add(tx, productIds, items);
      await this.audit.log(tx, { action: 'product.applicability_bulk', entityType: 'product', summary: `Применимость для ${productIds.length} товаров` });
      return { added };
    });
  }

  copy(fromId: string, toIds: string[]) {
    return this.tenantTx.run(async (tx) => {
      await tx.repo(Product, 'Товар').getById(fromId);
      await tx.repo(Product, 'Товар').getByIds(toIds);
      const added = await this.app.copy(tx, fromId, toIds);
      await this.audit.log(tx, { action: 'product.applicability_copy', entityType: 'product', entityId: fromId, summary: `Скопировано в ${toIds.length} товаров` });
      return { added };
    });
  }

  /** Список «Проверить применимость»: по товару — сколько возвратов и на какие машины. */
  fitIssues(f: { resolved?: boolean; productId?: string }) {
    return this.tenantTx.run(async (tx) => {
      const rows = await tx.query(
        `SELECT i.id, i.product_id AS "productId", p.name AS "productName", p.sku, i.vehicle_title AS "vehicleTitle",
                i.customer_vehicle_id AS "customerVehicleId", i.return_receipt_id AS "returnReceiptId", r.number AS "returnNumber",
                i.resolved, i.created_at AS "createdAt"
           FROM product_fit_issues i JOIN products p ON p.id = i.product_id
           LEFT JOIN receipts r ON r.id = i.return_receipt_id
          WHERE i.tenant_id = $1 AND i.resolved = $2 AND ($3::uuid IS NULL OR i.product_id = $3)
          ORDER BY i.created_at DESC LIMIT 500`,
        [tx.tenantId, !!f.resolved, f.productId ?? null],
      );
      const byProduct = new Map<string, any>();
      for (const r of rows) {
        const g = byProduct.get(r.productId) ?? { productId: r.productId, productName: r.productName, sku: r.sku, count: 0, vehicles: [] as string[], issues: [] as any[] };
        g.count++;
        if (!g.vehicles.includes(r.vehicleTitle)) g.vehicles.push(r.vehicleTitle);
        g.issues.push({ id: r.id, vehicleTitle: r.vehicleTitle, customerVehicleId: r.customerVehicleId, returnReceiptId: r.returnReceiptId, returnNumber: r.returnNumber, createdAt: r.createdAt });
        byProduct.set(r.productId, g);
      }
      return [...byProduct.values()].sort((a, b) => b.count - a.count);
    });
  }

  resolveFitIssue(id: string, note?: string) {
    return this.tenantTx.run(async (tx) => {
      const [rows] = await tx.query(
        `UPDATE product_fit_issues SET resolved = true, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING product_id, vehicle_title`,
        [tx.tenantId, id],
      );
      const r = rows?.[0];
      if (!r) throw Errors.notFound('Запись');
      await this.audit.log(tx, {
        action: 'product.fit_issue_resolved',
        entityType: 'product',
        entityId: r.product_id,
        summary: `Применимость проверена: ${r.vehicle_title}${note ? ` — ${String(note).slice(0, 200)}` : ''}`,
      });
      return { id, resolved: true };
    });
  }
}

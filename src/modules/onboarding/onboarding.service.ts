import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { D } from '../../common/utils/decimal';
import { normalizePhone } from '../../common/utils/login';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { SHOP_TYPE_PRESETS } from '../../database/seeds/presets/shop-types.preset';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { CatalogPresetsService } from '../catalog/catalog-presets.service';
import { MoneyAccount } from '../finance/entities/money-account.entity';
import { ShopRate } from '../pricing/entities/price-type.entity';
import { SettingsService } from '../settings/settings.service';
import { Register } from '../stores/entities/register.entity';
import { Store } from '../stores/entities/store.entity';
import { Warehouse } from '../stores/entities/warehouse.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { User } from '../users/entities/user.entity';
import { GlobalVehicleMake } from '../vehicles/entities/global-vehicle-make.entity';
import { CompleteOnboardingDto } from './dto/onboarding.dto';

/** Мастер первого запуска (ТЗ 23.7). */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly platform: PlatformDb,
    private readonly ctx: RequestContext,
    private readonly settings: SettingsService,
    private readonly catalogPresets: CatalogPresetsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  /** Данные для шагов мастера. */
  async state() {
    const tenant = await this.platform.repo(Tenant).findOneOrFail({ where: { id: this.ctx.requireTenantId() } });
    const makes = await this.platform.repo(GlobalVehicleMake).find({ order: { popularKg: 'DESC', sort: 'ASC', name: 'ASC' } });
    return {
      completed: !!tenant.onboardingCompletedAt,
      tenant: { name: tenant.name, city: tenant.city, language: tenant.language, shopType: tenant.shopType },
      shopTypes: SHOP_TYPE_PRESETS.map((p) => ({ type: p.type, name: p.name, description: p.description, suggestedRoles: p.suggestedRoles })),
      makes: makes.map((m) => ({ code: m.code, name: m.name, country: m.country, popular: m.popularKg })),
      checklist: await this.checklist(),
    };
  }

  async complete(dto: CompleteOnboardingDto) {
    if (!this.ctx.isOwner) throw Errors.forbidden('Мастер первого запуска проходит владелец');
    const preset = SHOP_TYPE_PRESETS.find((p) => p.type === dto.shopType)!;
    const tenantId = this.ctx.requireTenantId();

    if (dto.ourMakes?.length) {
      const found = await this.platform.repo(GlobalVehicleMake).find({ where: { code: In(dto.ourMakes) } });
      const unknown = dto.ourMakes.filter((c) => !found.some((f) => f.code === c));
      if (unknown.length) throw Errors.bad('UNKNOWN_MAKE', 'Неизвестные марки', unknown);
    }
    if (dto.shopRateUsd && (D(dto.shopRateUsd).lte(0) || D(dto.shopRateUsd).gt(10000))) {
      throw Errors.bad('BAD_RATE', 'Некорректный курс');
    }

    const result = await this.tenantTx.run(async (tx) => {
      // Шаг 2–3: магазин
      const tenantPatch: Partial<Tenant> = { shopType: dto.shopType, onboardingCompletedAt: new Date() };
      if (dto.shopName) tenantPatch.name = dto.shopName.trim();
      if (dto.city) tenantPatch.city = dto.city.trim();
      if (dto.language) tenantPatch.language = dto.language;
      await tx.manager.update(Tenant, { id: tenantId }, tenantPatch);

      // Готовые настройки по типу + наши марки (шаг 3–4)
      const settings = await this.settings.patchInTx(tx, {
        ...preset.settings,
        ...(dto.ourMakes ? { ourMakes: dto.ourMakes } : {}),
      });

      // Каталог: категории, типы деталей, атрибуты
      const catalog = await this.catalogPresets.apply(tx);

      // Шаг 5: точка, склад, касса — уже созданы при регистрации, переименуем
      const store = await this.firstStore(tx);
      if (dto.storeName || dto.storeCode || dto.storeAddress !== undefined) {
        if (dto.storeName) store.name = dto.storeName.trim();
        if (dto.storeCode && dto.storeCode.toUpperCase() !== store.code) {
          const newCode = dto.storeCode.toUpperCase();
          const taken = await tx.repo(Store).count({ where: { code: newCode } });
          if (taken) throw Errors.conflict('CODE_TAKEN', 'Точка с таким кодом уже есть');
          // Коды складов точки начинаются с кода точки: Т1-ЗАЛ → ДОР-ЗАЛ
          await tx.query(
            `UPDATE warehouses SET code = $3 || substr(code, length($2) + 1)
              WHERE tenant_id = $1 AND store_id = $4 AND code LIKE $2 || '-%'`,
            [tx.tenantId, store.code, newCode, store.id],
          );
          store.code = newCode;
        }
        if (dto.storeAddress !== undefined) store.address = dto.storeAddress;
        await tx.repo(Store).save(store);
      }
      await tx.manager.update(
        Warehouse,
        { tenantId: tx.tenantId, storeId: store.id },
        { storageLevel: settings.defaultStorageLevel },
      );
      const defect = await tx.repo(Warehouse).findOne({ where: { storeId: store.id, type: 'defect' } });
      if (!defect) {
        await tx.repo(Warehouse).insert({
          storeId: store.id,
          name: 'Брак',
          code: `${store.code}-БРАК`,
          type: 'defect',
          storageLevel: 1,
        });
      }

      // Шаг 7: курс и кошельки
      if (dto.shopRateUsd) await tx.repo(ShopRate).insert({ currency: 'USD', rate: D(dto.shopRateUsd), note: 'Мастер первого запуска' });
      for (const w of dto.wallets ?? []) {
        const phone = normalizePhone(w.phone) ?? w.phone;
        await tx.repo(MoneyAccount).insert({
          type: 'wallet',
          name: `${w.provider} — ${w.holderName} — ${w.phone}`,
          currency: 'KGS',
          storeId: store.id,
          details: { provider: w.provider, phone },
        });
      }

      await this.audit.log(tx, {
        action: 'onboarding.complete',
        entityType: 'tenant',
        entityId: tenantId,
        summary: `Мастер первого запуска: ${preset.name}`,
        after: { shopType: dto.shopType, ourMakes: dto.ourMakes ?? [], catalog },
        important: true,
      });
      return { catalog, settings };
    });
    this.access.invalidateTenant(tenantId);
    return { ok: true, ...result, checklist: await this.checklist() };
  }

  private async firstStore(tx: TenantTx) {
    const store = await tx.repo(Store).findOne({ where: {}, order: { createdAt: 'ASC' } });
    if (!store) throw Errors.bad('NO_STORE', 'Нет точки');
    return store;
  }

  /** Чек-лист «Первые шаги» на дашборде (ТЗ 23.7, шаг 9). Пункты заполняются по мере появления модулей. */
  async checklist() {
    return this.tenantTx.run(async (tx) => {
      const exists = async (table: string, extra = '') => {
        const [{ reg }] = await tx.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
        if (!reg) return false;
        const rows = await tx.query(`SELECT 1 FROM "${table}" WHERE tenant_id = $1 ${extra} LIMIT 1`, [tx.tenantId]);
        return rows.length > 0;
      };
      const owner = await this.platform.repo(User).findOne({ where: { id: this.ctx.userId! } });
      const registers = await tx.repo(Register).count();
      return [
        { key: 'first_product', title: 'Добавить первый товар', done: await exists('products') },
        { key: 'first_sale', title: 'Первая продажа', done: await exists('receipts') },
        { key: 'printer', title: 'Подключить принтер', done: await exists('devices', `AND kind = 'agent'`) },
        { key: 'telegram', title: 'Подключить Telegram', done: !!owner?.telegramChatId },
        { key: 'register', title: 'Касса создана', done: registers > 0 },
      ];
    });
  }
}

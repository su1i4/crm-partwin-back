import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../auth/access.service';
import { StoredFile } from '../files/entities/file.entity';
import { UpdateTenantDto } from './dto/tenant.dto';
import { Tenant } from './entities/tenant.entity';

/** Аккаунт магазина: реквизиты, логотип, язык. Строку tenants видит только сам магазин. */
@Injectable()
export class TenantsService {
  constructor(
    private readonly platform: PlatformDb,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async current(): Promise<Tenant> {
    const id = this.ctx.requireTenantId();
    const t = await this.platform.repo(Tenant).findOne({ where: { id } });
    if (!t) throw Errors.notFound('Магазин');
    return t;
  }

  view(t: Tenant) {
    const { ownerUserId: _o, ...rest } = t;
    return rest;
  }

  async update(dto: UpdateTenantDto) {
    const tenant = await this.current();
    const before = { ...tenant };
    return this.tenantTx.run(async (tx) => {
      if (dto.logoFileId) {
        const file = await tx.repo(StoredFile, 'Файл').getById(dto.logoFileId);
        if (!file.mime.startsWith('image/')) throw Errors.bad('NOT_IMAGE', 'Логотип должен быть картинкой');
      }
      const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      await tx.manager.update(Tenant, { id: tenant.id }, patch);
      const after = await tx.manager.findOneByOrFail(Tenant, { id: tenant.id });
      await this.audit.log(tx, {
        action: 'tenant.update',
        entityType: 'tenant',
        entityId: tenant.id,
        summary: 'Изменены данные магазина',
        before,
        after,
      });
      tx.onCommit(() => this.access.invalidateTenant(tenant.id));
      return this.view(after);
    });
  }
}

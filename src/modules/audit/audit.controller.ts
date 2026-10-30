import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { ScopeService } from '../auth/scope.service';
import { AuditQueryDto } from './dto/audit-query.dto';

@ApiTags('Журнал действий')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @RequirePermission('audit.read')
  @ApiOperation({ summary: 'Журнал действий: кто, когда, что изменил' })
  list(@Query() q: AuditQueryDto) {
    return this.tenantTx.run(async (tx) => {
      const where: string[] = ['a.tenant_id = $1'];
      const params: unknown[] = [tx.tenantId];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.entityType) add('a.entity_type = ?', q.entityType);
      if (q.entityId) add('a.entity_id = ?', q.entityId);
      if (q.userId) add('a.user_id = ?', q.userId);
      if (q.action) add(`a.action LIKE ? || '%'`, q.action);
      if (q.important) where.push('a.important = true');
      if (q.from) add('a.created_at >= ?', q.from);
      if (q.to) add('a.created_at < ?', q.to);
      if (q.q) add(`a.summary ILIKE '%' || ? || '%'`, q.q);
      const stores = this.scope.storeIds();
      if (stores !== null) add('a.store_id = ANY(?::uuid[])', stores);

      const whereSql = where.join(' AND ');
      const [{ count }] = await tx.query(`SELECT count(*)::int AS count FROM audit_log a WHERE ${whereSql}`, params);
      const items = await tx.query(
        `SELECT a.id, a.created_at AS "createdAt", a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
                a.summary, a.diff, a.before, a.after, a.important, a.store_id AS "storeId", a.ip,
                a.user_agent AS "userAgent", a.user_id AS "userId", u.name AS "userName",
                a.support_session_id AS "supportSessionId"
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE ${whereSql}
          ORDER BY a.created_at DESC
          LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        params,
      );
      return { items, total: count };
    });
  }
}

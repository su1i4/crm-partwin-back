import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditLog } from './entities/audit-log.entity';

const HIDDEN_FIELDS = new Set(['passwordHash', 'totpSecretEnc', 'pinHash', 'refreshHash', 'codeHash', 'tokenHash']);
const SKIP_DIFF = new Set(['updatedAt', 'version', 'createdAt']);

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  summary?: string;
  before?: object | null;
  after?: object | null;
  important?: boolean;
  storeId?: string | null;
}

function sanitize(obj: object | null | undefined): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (HIDDEN_FIELDS.has(k)) continue;
    if (typeof v === 'function') continue;
    out[k] = v instanceof Date ? v.toISOString() : v && typeof v === 'object' && 'toFixed' in v ? String(v) : v;
  }
  return JSON.parse(JSON.stringify(out));
}

export function diffObjects(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return null;
  const diff: Record<string, [unknown, unknown]> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (SKIP_DIFF.has(k)) continue;
    const a = JSON.stringify(before[k] ?? null);
    const b = JSON.stringify(after[k] ?? null);
    if (a !== b) diff[k] = [before[k] ?? null, after[k] ?? null];
  }
  return Object.keys(diff).length ? diff : null;
}

/**
 * Журнал действий (ТЗ 22.3). Пишется в той же транзакции, что и изменение.
 * Важные действия (important) — отмена проведения, изменение цен и прав, открытие периода …
 */
@Injectable()
export class AuditService {
  constructor(private readonly ctx: RequestContext) {}

  async log(tx: TenantTx, e: AuditEntry): Promise<void> {
    const before = sanitize(e.before);
    const after = sanitize(e.after);
    await tx.manager.insert(AuditLog, {
      tenantId: tx.tenantId,
      userId: tx.userId,
      membershipId: this.ctx.membershipId ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      summary: e.summary?.slice(0, 300) ?? null,
      before: before as any,
      after: after as any,
      diff: diffObjects(before, after) as any,
      important: e.important ?? false,
      storeId: e.storeId ?? this.ctx.get('currentStoreId') ?? null,
      ip: this.ctx.get('ip') ?? null,
      userAgent: this.ctx.get('userAgent')?.slice(0, 400) ?? null,
      deviceId: this.ctx.get('deviceId') ?? null,
      supportSessionId: this.ctx.get('supportSessionId') ?? null,
    });
  }
}

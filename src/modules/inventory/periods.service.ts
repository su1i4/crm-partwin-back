import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { SettingsService } from '../settings/settings.service';

/** Закрытый период и «документы старше N дней» (ТЗ 7.5, 9.2). */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly ctx: RequestContext,
  ) {}

  /** Граница закрытого периода: всё, что раньше, неизменяемо. null — ничего не закрыто. */
  async closedUntil(tx: TenantTx): Promise<Date | null> {
    if (tx.memo.has('period:closedUntil')) return tx.memo.get('period:closedUntil') as Date | null;
    const [r] = await tx.query(`SELECT max(period_end) AS d FROM period_closes WHERE tenant_id = $1 AND status = 'closed'`, [tx.tenantId]);
    const d = r?.d ? new Date(r.d) : null;
    tx.memo.set('period:closedUntil', d);
    return d;
  }

  /** Можно ли менять документ с этой датой (проводить, отменять, править, удалять). */
  async assertEditable(tx: TenantTx, docDate: Date, opts: { checkAge?: boolean } = { checkAge: true }) {
    const closed = await this.closedUntil(tx);
    if (closed && docDate < closed) {
      throw Errors.conflict('PERIOD_CLOSED', 'Период закрыт: исправление — документом в текущем периоде', { closedUntil: closed });
    }
    if (opts.checkAge !== false) {
      const s = await this.settings.get(tx);
      const limit = new Date(Date.now() - s.editOldDocumentsDays * 86_400_000);
      if (s.editOldDocumentsDays > 0 && docDate < limit && !this.ctx.can('documents.edit_old')) {
        throw Errors.forbidden(`Документы старше ${s.editOldDocumentsDays} дней изменять нельзя`);
      }
    }
  }
}

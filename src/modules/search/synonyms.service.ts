import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { baseNormalize } from '../../common/utils/text-search';
import { PlatformDb } from '../../database/tenant/platform-db';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { AuditService } from '../audit/audit.service';
import { GlobalSearchSynonym, SearchSynonym } from './entities/search.entity';

export interface SynonymPair {
  word: string;
  target: string;
}

/** Словарь сленга и синонимов (ТЗ 5.5): базовый платформы + свой магазина. */
@Injectable()
export class SynonymsService {
  private globalCache?: { at: number; rows: SynonymPair[] };

  constructor(
    private readonly platform: PlatformDb,
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
  ) {}

  async globalPairs(): Promise<SynonymPair[]> {
    if (this.globalCache && Date.now() - this.globalCache.at < 10 * 60_000) return this.globalCache.rows;
    const rows = await this.platform.repo(GlobalSearchSynonym).find();
    this.globalCache = { at: Date.now(), rows: rows.map((r) => ({ word: r.word, target: r.target })) };
    return this.globalCache.rows;
  }

  async all(tx: TenantTx): Promise<SynonymPair[]> {
    const own = await tx.repo(SearchSynonym).find();
    return [...(await this.globalPairs()), ...own.map((o) => ({ word: o.word, target: o.target }))];
  }

  async list() {
    return this.tenantTx.run(async (tx) => {
      const own = await tx.repo(SearchSynonym).find({ order: { word: 'ASC' } });
      const global = await this.globalPairs();
      return {
        own: own.map((o) => ({ id: o.id, word: o.word, target: o.target, version: o.version })),
        global,
      };
    });
  }

  async create(word: string, target: string) {
    const w = baseNormalize(word);
    const t = baseNormalize(target);
    if (!w || !t) throw Errors.bad('BAD_SYNONYM', 'Заполните слово и что искать');
    if (w === t) throw Errors.bad('BAD_SYNONYM', 'Слово и замена совпадают');
    return this.tenantTx.run(async (tx) => {
      if (await tx.repo(SearchSynonym).count({ where: { word: w, target: t } })) {
        throw Errors.conflict('SYNONYM_EXISTS', 'Такой синоним уже есть');
      }
      const row = await tx.repo(SearchSynonym).insert({ word: w, target: t });
      await this.audit.log(tx, { action: 'synonym.create', entityType: 'synonym', entityId: row.id, summary: `${w} → ${t}` });
      return row;
    });
  }

  async remove(id: string) {
    await this.tenantTx.run(async (tx) => {
      const s = await tx.repo(SearchSynonym, 'Синоним').getById(id);
      await tx.repo(SearchSynonym).softDelete(id);
      await this.audit.log(tx, { action: 'synonym.delete', entityType: 'synonym', entityId: id, summary: `${s.word} → ${s.target}` });
    });
  }
}

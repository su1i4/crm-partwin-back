import { Decimal } from '../../../common/utils/decimal';
import { TenantTx } from '../../../database/tenant/tenant-tx';
import { Product } from '../../catalog/entities/product.entity';
import { PlannedMovement } from '../../inventory/stock-ledger.service';
import { TenantSettingsData } from '../../settings/settings.types';
import { Document, DocumentLine, DocumentType } from '../entities/document.entity';

export interface PostingContext {
  tx: TenantTx;
  doc: Document;
  lines: DocumentLine[];
  products: Map<string, Product>;
  settings: TenantSettingsData;
}

/** Обработчик проведения для вида документа (ТЗ 2.4.7). */
export interface PostingHandler {
  type: DocumentType;
  /** Проверка шапки при сохранении черновика */
  validateHeader?(ctx: PostingContext): Promise<void>;
  /** Перед проведением: строгие проверки, подготовка (серийные экземпляры, себестоимость) */
  beforePost?(ctx: PostingContext): Promise<void>;
  /** Движения товара */
  plan(ctx: PostingContext): Promise<PlannedMovement[]>;
  afterPost?(ctx: PostingContext): Promise<void>;
  /** Перед отменой: можно ли (например, перемещение уже принято) */
  beforeUnpost?(ctx: PostingContext): Promise<void>;
  afterUnpost?(ctx: PostingContext): Promise<void>;
}

/** Товар ведёт остаток: обычный товар без флага «без контроля остатка». */
export const tracksStock = (p: Product | undefined) => !!p && p.kind === 'goods' && !p.noStockControl;

export interface LineCost {
  lineId: string;
  unitCost: Decimal;
}

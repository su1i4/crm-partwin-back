import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app.exception';
import { dayjs } from '../../common/utils/dates';
import { D } from '../../common/utils/decimal';
import { AppConfig } from '../../config/app.config';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { TenantTx } from '../../database/tenant/tenant-tx';
import { Store } from '../stores/entities/store.entity';
import { Receipt } from './entities/receipt.entity';
import { ReceiptsService, tenantFromToken } from './receipts.service';

const METHOD_LABELS: Record<string, string> = {
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
  debt: 'В долг',
  return_credit: 'Зачёт возврата',
  advance: 'Аванс / предоплата',
};

/**
 * Чек для печати (ТЗ 13.6) и электронный чек по ссылке: магазин, номер, продавец, позиции, скидки, оплаты, сдача,
 * гарантия и правила возврата по позициям, QR. Себестоимость, мастер и закупочные цены сюда не попадают.
 */
@Injectable()
export class ReceiptPrintService {
  constructor(
    private readonly tenantTx: TenantTransaction,
    private readonly receipts: ReceiptsService,
    private readonly config: AppConfig,
  ) {}

  url(token: string) {
    return `${this.config.publicUrl.replace(/\/$/, '')}/r/${token}`;
  }

  async printable(tx: TenantTx, receiptId: string) {
    const v: any = await this.receipts.viewInTx(tx, receiptId);
    if (v.status !== 'completed') throw Errors.conflict('NOT_COMPLETED', 'Чек ещё не оплачен');
    const store = await tx.repo(Store).findById(v.storeId);
    const tz = store?.timezone ?? 'Asia/Bishkek';
    const sign = v.kind === 'return' ? -1 : 1;
    return {
      kind: v.kind,
      title: v.kind === 'return' ? 'Возврат' : 'Товарный чек',
      store: { name: v.storeName, address: v.storeAddress, phone: v.storePhone },
      number: v.number,
      date: dayjs(v.completedAt).tz(tz).format('DD.MM.YYYY HH:mm'),
      register: v.registerName,
      seller: firstName(v.sellerName),
      customer: v.customerName ?? null,
      vehicle: v.vehicleTitle ? `${v.vehicleTitle}${v.vehiclePlate ? ` (${v.vehiclePlate})` : ''}` : (v.vehicleLabel ?? null),
      lines: v.lines.map((l: any) => ({
        name: l.name,
        qty: D(l.qty).toFixed(),
        unit: l.unitName,
        price: D(l.price).toFixed(2),
        discount: D(l.promoDiscount ?? 0).plus(l.lineDiscount ?? 0).plus(l.receiptDiscount ?? 0).toFixed(2),
        amount: D(l.amount).toFixed(2),
        warranty: l.rules?.warrantyDays ? `Гарантия ${l.rules.warrantyDays} дн.` : null,
        returnRule: l.rules?.returnConditions ?? (l.rules?.returnDays !== null && l.rules?.returnDays !== undefined ? `Возврат ${l.rules.returnDays} дн.` : null),
      })),
      subtotal: D(v.subtotal).toFixed(2),
      discount: D(v.discountTotal).toFixed(2),
      total: D(v.total).toFixed(2),
      totalUsd: v.totalUsd,
      rate: v.rate ? D(v.rate).toFixed(2) : null,
      payments: v.payments.map((p: any) => ({
        method: METHOD_LABELS[p.method] ?? p.method,
        account: p.method === 'transfer' ? p.accountName : null,
        currency: p.currency,
        amount: D(p.amount).mul(sign).toFixed(2),
      })),
      change: D(v.change).gt(0) ? { amount: D(v.change).toFixed(2), currency: v.changeCurrency } : null,
      debt: D(v.debtAmount).gt(0) ? D(v.debtAmount).toFixed(2) : null,
      qr: v.publicToken ? this.url(v.publicToken) : null,
      footer: 'Спасибо за покупку!',
    };
  }

  /** Электронный чек по ссылке из QR — без входа. */
  async publicView(token: string) {
    const tenantId = tenantFromToken(token);
    if (!tenantId) throw Errors.notFound('Чек');
    return this.tenantTx
      .run(
        async (tx) => {
          const r = await tx.repo(Receipt).findOne({ where: { publicToken: token } });
          if (!r) throw Errors.notFound('Чек');
          return this.printable(tx, r.id);
        },
        { tenantId, userId: null },
      )
      .catch((e) => {
        if (e?.code === 'NOT_FOUND' || e?.response?.code === 'NOT_FOUND') throw e;
        throw Errors.notFound('Чек');
      });
  }

  /** Ссылка и текст для кнопки «WhatsApp» (ТЗ 13.6). */
  share(receiptId: string) {
    return this.tenantTx.run(async (tx) => {
      const v: any = await this.receipts.viewInTx(tx, receiptId);
      if (!v.publicToken) throw Errors.conflict('NOT_COMPLETED', 'Чек ещё не оплачен');
      const url = this.url(v.publicToken);
      const text = `${v.storeName}: ${v.kind === 'return' ? 'возврат' : 'чек'} ${v.number} на ${D(v.total).toFixed(0)} сом.\n${url}`;
      const phone = (v.customerPhone ?? '').replace(/\D/g, '');
      return { url, text, whatsappUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}` };
    });
  }
}

const firstName = (n?: string | null) => (n ?? '').trim().split(/\s+/)[0] || null;

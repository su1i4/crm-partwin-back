import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { PageQueryDto } from '../../common/dto/pagination.dto';
import { VersionDto } from '../../common/dto/version.dto';
import { RequestContext } from '../../common/context/request-context';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { DevicesService } from '../devices/devices.service';
import { Product } from '../catalog/entities/product.entity';
import { NeighborPurchase } from './entities/receipt.entity';
import { PinService } from './pin.service';
import {
  CreateReceiptDto,
  CreateReturnDto,
  DeferDto,
  ExchangeDto,
  FindSalesQuery,
  LastPricesQuery,
  LinkNeighborDto,
  MatchDto,
  NotReceivedDto,
  PayDto,
  PeriodQuery,
  ReceiptsQuery,
  ResumeDto,
  SaleDto,
  TransfersQuery,
  UpdateReceiptDto,
  VerifyDto,
  WarrantyCreateDto,
  WarrantyDecideDto,
  WarrantyQuery,
  WarrantyStatusDto,
} from './pos.dto';
import { ReceiptPrintService } from './receipt-print.service';
import { ReceiptsService } from './receipts.service';
import { ReturnsService } from './returns.service';
import { TransfersCheckService } from './transfers-check.service';
import { WarrantyService } from './warranty.service';

@ApiTags('Касса')
@Controller('pos')
export class PosController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly returns: ReturnsService,
    private readonly print: ReceiptPrintService,
    private readonly devices: DevicesService,
    private readonly pins: PinService,
    private readonly tenantTx: TenantTransaction,
    private readonly ctx: RequestContext,
  ) {}

  // ── Чеки ─────────────────────────────────────────────────

  @Post('receipts')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Новый чек на кассе (нужна открытая смена)' })
  create(@Body() dto: CreateReceiptDto) {
    return this.receipts.create(dto);
  }

  @Get('receipts')
  @RequireAnyPermission('pos.use', 'reports.sales')
  @ApiOperation({ summary: 'Чеки: ?status=open,deferred — отложенные (видны всем кассам точки)' })
  list(@Query() q: ReceiptsQuery) {
    return this.receipts.list(q);
  }

  @Get('receipts/:id')
  @RequireAnyPermission('pos.use', 'reports.sales')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.receipts.get(id);
  }

  @Patch('receipts/:id')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Строки, клиент, машина, мастер, скидки. Строки с lineId держат цену на момент добавления' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReceiptDto) {
    return this.receipts.update(id, dto.version, dto);
  }

  @Post('receipts/:id/defer')
  @RequirePermission('pos.use')
  defer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeferDto) {
    return this.receipts.defer(id, dto.version, dto.label);
  }

  @Post('receipts/:id/resume')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Продолжить отложенный чек на этой кассе' })
  resume(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResumeDto) {
    return this.receipts.resume(id, dto.registerId);
  }

  @Post('receipts/:id/cancel')
  @RequirePermission('pos.use')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.receipts.cancel(id, dto.version);
  }

  @Post('receipts/:id/pay')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Оплата: наличные сом/доллары, карта, перевод, долг, смешанная. 409 с requiresPin — нужен PIN старшего' })
  pay(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayDto) {
    return this.receipts.pay(id, dto.version, dto);
  }

  @Post('sales')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Продажа одним запросом с ключом идемпотентности (повтор при плохом интернете — тот же чек)' })
  sale(@Body() dto: SaleDto) {
    return this.receipts.sale({ ...dto, lines: dto.lines ?? [] });
  }

  @Get('last-prices')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: '«Как в прошлый раз»: последняя цена продажи клиенту' })
  lastPrices(@Query() q: LastPricesQuery) {
    return this.receipts.lastPrices(q.customerId, q.productIds);
  }

  @Post('receipts/:id/print')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Печать (и повторная печать) чека через агент кассы' })
  printReceipt(@Param('id', ParseUUIDPipe) id: string, @Query('registerId') registerId?: string) {
    return this.tenantTx.run(async (tx) => {
      const payload = await this.print.printable(tx, id);
      const r = await this.receipts.viewInTx(tx, id);
      const job = await this.devices.enqueue(tx, registerId ?? r.registerId, 'receipt', payload);
      return { jobId: job.id, status: job.status };
    });
  }

  @Get('receipts/:id/printable')
  @RequireAnyPermission('pos.use', 'reports.sales')
  @ApiOperation({ summary: 'Данные чека для печати (запасной вариант — PDF/печать из браузера)' })
  printable(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenantTx.run((tx) => this.print.printable(tx, id));
  }

  @Get('receipts/:id/share')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Ссылка на электронный чек и кнопка «WhatsApp»' })
  share(@Param('id', ParseUUIDPipe) id: string) {
    return this.print.share(id);
  }

  // ── PIN ──────────────────────────────────────────────────

  @Post('pin')
  @RequirePermission('pos.use')
  @ApiOperation({ summary: 'Выдать себе новый PIN (показывается один раз)' })
  issuePin() {
    return this.pins.issue();
  }

  @Put('staff/:membershipId/pin')
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Выдать PIN сотруднику' })
  issueStaffPin(@Param('membershipId', ParseUUIDPipe) id: string) {
    return this.pins.issue(id);
  }

  @Delete('staff/:membershipId/pin')
  @HttpCode(204)
  @RequirePermission('staff.manage')
  async revokePin(@Param('membershipId', ParseUUIDPipe) id: string) {
    await this.pins.revoke(id);
  }

  // ── Возвраты и обмен ─────────────────────────────────────

  @Get('returns/lookup')
  @RequireAnyPermission('sales.return', 'sales.return_any')
  @ApiOperation({ summary: 'Найти продажу по QR, номеру чека или документа; что можно вернуть' })
  lookup(@Query('code') code: string) {
    if (!code) throw Errors.bad('CODE_REQUIRED', 'Отсканируйте QR или введите номер чека');
    return this.returns.lookup(code);
  }

  @Get('returns/find-sales')
  @RequirePermission('sales.return_any')
  @ApiOperation({ summary: 'Возврат без чека: поиск продажи по товару и клиенту' })
  findSales(@Query() q: FindSalesQuery) {
    return this.returns.findSales(q);
  }

  @Post('returns')
  @RequireAnyPermission('sales.return', 'sales.return_any', 'pos.use')
  @ApiOperation({ summary: 'Возврат по чеку или без; деньги — теми же способами в той же пропорции' })
  createReturn(@Body() dto: CreateReturnDto) {
    return this.returns.create(dto);
  }

  @Post('exchanges')
  @RequireAnyPermission('sales.return', 'sales.return_any', 'pos.use')
  @ApiOperation({ summary: 'Обмен: возврат + продажа одной операцией; доплата или сдача — разница' })
  exchange(@Body() dto: ExchangeDto) {
    return this.returns.exchange(dto);
  }

  // ── «Взял у соседа» ──────────────────────────────────────

  @Get('neighbor-purchases')
  @RequireAnyPermission('purchasing.suppliers', 'reports.sales')
  @ApiOperation({ summary: '«Что брали у соседей» — подсказка, что закупать самим' })
  neighborReport(@Query() q: PeriodQuery & PageQueryDto) {
    return this.tenantTx.run(async (tx) => {
      const params = [tx.tenantId, q.from ?? '1970-01-01', q.to ?? '2999-01-01'];
      const groups = await tx.query(
        `SELECT coalesce(n.product_id::text, lower(coalesce(n.part_number, n.name))) AS key, max(n.name) AS name, max(n.part_number) AS "partNumber",
                n.product_id AS "productId", count(*)::int AS times, sum(n.qty) AS qty, sum(n.sale_price * n.qty - n.purchase_price * n.qty) AS profit,
                array_agg(DISTINCT c.name) AS neighbors
           FROM neighbor_purchases n JOIN counterparties c ON c.id = n.neighbor_id
          WHERE n.tenant_id = $1 AND n.created_at >= $2 AND n.created_at < $3
          GROUP BY 1, n.product_id ORDER BY times DESC, qty DESC LIMIT 200`,
        params,
      );
      const recent = await tx.query(
        `SELECT n.id, n.name, n.part_number AS "partNumber", n.product_id AS "productId", n.qty, n.purchase_price AS "purchasePrice", n.sale_price AS "salePrice",
                n.created_at AS "createdAt", c.name AS neighbor, d.number AS "documentNumber"
           FROM neighbor_purchases n JOIN counterparties c ON c.id = n.neighbor_id JOIN documents d ON d.id = n.document_id
          WHERE n.tenant_id = $1 AND n.created_at >= $2 AND n.created_at < $3 ORDER BY n.created_at DESC LIMIT 100`,
        params,
      );
      return { groups, recent };
    });
  }

  @Post('neighbor-purchases/:id/link')
  @RequireAnyPermission('products.write', 'products.quick_create')
  @ApiOperation({ summary: 'Привязать позицию соседа к карточке товара' })
  linkNeighbor(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkNeighborDto) {
    return this.tenantTx.run(async (tx) => {
      const n = await tx.repo(NeighborPurchase, 'Позиция').getById(id);
      const p = await tx.repo(Product, 'Товар').getById(dto.productId);
      await tx.query(`UPDATE neighbor_purchases SET product_id = $3 WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, n.id, p.id]);
      await tx.query(`UPDATE document_lines SET extra = jsonb_set(extra, '{neighbor,productId}', to_jsonb($3::text)) WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, n.lineId, p.id]);
      return { id: n.id, productId: p.id };
    });
  }

  // ── Отчёты кассы ─────────────────────────────────────────

  @Get('reports/below-cost')
  @RequirePermission('reports.profit')
  @ApiOperation({ summary: '«Продажи ниже себестоимости»' })
  belowCost(@Query() q: PeriodQuery) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT r.id AS "receiptId", r.number, r.completed_at AS "date", l.product_id AS "productId", coalesce(l.extra->>'name', p.name) AS name,
                l.qty, l.amount, l.cost_amount AS "costAmount", l.amount - l.cost_amount AS loss, u.name AS seller, r.approvals
           FROM receipts r JOIN document_lines l ON l.tenant_id = r.tenant_id AND l.document_id = r.document_id JOIN products p ON p.id = l.product_id
           LEFT JOIN memberships m ON m.id = r.seller_membership_id LEFT JOIN users u ON u.id = m.user_id
          WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND l.cost_amount > l.amount
            AND r.completed_at >= $2 AND r.completed_at < $3 ORDER BY r.completed_at DESC LIMIT 500`,
        [tx.tenantId, q.from ?? '1970-01-01', q.to ?? '2999-01-01'],
      ),
    );
  }

  @Get('reports/free-items')
  @RequireAnyPermission('products.write', 'reports.sales')
  @ApiOperation({ summary: '«Свободные позиции» — для дозаполнения каталога' })
  freeItems(@Query() q: PeriodQuery) {
    return this.tenantTx.run((tx) =>
      tx.query(
        `SELECT lower(l.extra->'free'->>'name') AS key, max(l.extra->'free'->>'name') AS name, count(*)::int AS times, sum(l.qty) AS qty,
                round(avg(l.price), 2) AS "avgPrice", max(r.completed_at) AS "lastAt"
           FROM receipts r JOIN document_lines l ON l.tenant_id = r.tenant_id AND l.document_id = r.document_id
          WHERE r.tenant_id = $1 AND r.kind = 'sale' AND r.status = 'completed' AND l.extra ? 'free'
            AND r.completed_at >= $2 AND r.completed_at < $3 GROUP BY 1 ORDER BY times DESC LIMIT 300`,
        [tx.tenantId, q.from ?? '1970-01-01', q.to ?? '2999-01-01'],
      ),
    );
  }

  @Get('pin/status')
  @RequirePermission('pos.use')
  pinStatus() {
    return this.tenantTx.run(async (tx) => {
      const [m] = await tx.query(`SELECT pin_set_at AS "pinSetAt" FROM memberships WHERE tenant_id = $1 AND id = $2`, [tx.tenantId, this.ctx.membershipId]);
      return { hasPin: !!m?.pinSetAt, pinSetAt: m?.pinSetAt ?? null };
    });
  }
}

@ApiTags('Гарантия')
@Controller('warranty')
export class WarrantyController {
  constructor(private readonly service: WarrantyService) {}

  @Get()
  @RequireAnyPermission('sales.warranty', 'pos.use')
  list(@Query() q: WarrantyQuery) {
    return this.service.list(q);
  }

  @Get('report')
  @RequireAnyPermission('sales.warranty', 'reports.sales')
  @ApiOperation({ summary: '«Гарантийные обращения» по брендам и поставщикам' })
  report(@Query() q: PeriodQuery) {
    return this.service.report(q);
  }

  @Get(':id')
  @RequireAnyPermission('sales.warranty', 'pos.use')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequireAnyPermission('sales.warranty', 'pos.use')
  @ApiOperation({ summary: 'Принять деталь по гарантии' })
  create(@Body() dto: WarrantyCreateDto) {
    return this.service.create(dto);
  }

  @Post(':id/status')
  @RequirePermission('sales.warranty')
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WarrantyStatusDto) {
    return this.service.setStatus(id, dto.version, dto);
  }

  @Post(':id/decide')
  @RequirePermission('sales.warranty')
  @ApiOperation({ summary: 'Решение: замена, возврат денег или отказ с причиной' })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WarrantyDecideDto) {
    return this.service.decide(id, dto.version, dto);
  }
}

@ApiTags('Деньги, смены, долги')
@Controller('money/transfers')
export class TransfersController {
  constructor(private readonly service: TransfersCheckService) {}

  @Get()
  @RequirePermission('money.verify_transfers')
  @ApiOperation({ summary: 'Переводы на кошельки: «не сверено» / сверено / не поступило' })
  list(@Query() q: TransfersQuery) {
    return this.service.list(q);
  }

  @Get('summary')
  @RequirePermission('money.verify_transfers')
  @ApiOperation({ summary: '«Несверенные переводы» по дням, продавцам и кошелькам' })
  summary(@Query() q: PeriodQuery) {
    return this.service.summary(q);
  }

  @Post('verify')
  @RequirePermission('money.verify_transfers')
  verify(@Body() dto: VerifyDto) {
    return this.service.verify(dto.ids);
  }

  @Post(':id/not-received')
  @RequirePermission('money.verify_transfers')
  @ApiOperation({ summary: '«Не поступило»: в долг клиента или отмена чека' })
  notReceived(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NotReceivedDto) {
    return this.service.notReceived(id, dto);
  }

  @Post('match')
  @RequirePermission('money.verify_transfers')
  @ApiOperation({ summary: 'Сопоставить с выпиской банка (Excel/CSV) по сумме и времени' })
  match(@Body() dto: MatchDto) {
    return this.service.match(dto);
  }
}

@ApiTags('Электронный чек')
@Controller('public')
export class PublicReceiptController {
  constructor(private readonly print: ReceiptPrintService) {}

  @Public()
  @Get('receipts/:token')
  @ApiOperation({ summary: 'Электронный чек по ссылке из QR (без входа)' })
  receipt(@Param('token') token: string) {
    return this.print.publicView(token);
  }
}

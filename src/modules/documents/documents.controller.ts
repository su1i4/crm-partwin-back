import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/auth.decorators';
import { LabelsService } from '../printing/labels.service';
import { DocumentsService } from './documents.service';
import { AcceptTransferDto, AttachmentDto, BasedOnDto, CreateDocumentDto, DocumentListQueryDto, PostDocumentDto, UpdateDocumentDto } from './dto/document.dto';
import { DOCUMENT_TYPES } from './entities/document.entity';
import { WRITEOFF_REASONS } from './handlers/stock-handlers';
import { TransfersService } from './transfers.service';

@ApiTags('Документы')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly transfers: TransfersService,
    private readonly labels: LabelsService,
  ) {}

  @Get('meta')
  @RequirePermission('documents.read')
  @ApiOperation({ summary: 'Виды документов и причины списания' })
  meta() {
    return {
      types: Object.entries(DOCUMENT_TYPES).map(([code, t]) => ({ code, ...t })),
      writeoffReasons: Object.entries(WRITEOFF_REASONS).map(([code, label]) => ({ code, label })),
    };
  }

  @Get()
  @RequirePermission('documents.read')
  @ApiOperation({ summary: 'Журнал документов с фильтрами' })
  list(@Query() q: DocumentListQueryDto) {
    return this.docs.list(q);
  }

  @Get('transfers/stale')
  @RequirePermission('documents.read')
  @ApiOperation({ summary: '«Зависшие» перемещения — в пути дольше N дней' })
  stale() {
    return this.transfers.stale();
  }

  @Post()
  @RequirePermission('documents.write')
  @ApiOperation({ summary: 'Создать документ (черновик; post=true — сразу провести)' })
  create(@Body() dto: CreateDocumentDto) {
    return this.docs.create(dto);
  }

  @Get(':id')
  @RequirePermission('documents.read')
  @ApiOperation({ summary: 'Документ: шапка, строки, связанные документы, вложения' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.docs.view(id);
  }

  @Patch(':id')
  @RequirePermission('documents.write')
  @ApiOperation({ summary: 'Изменить черновик / исправить проведённый (перепроведение)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentDto) {
    return this.docs.update(id, dto);
  }

  @Post(':id/post')
  @HttpCode(200)
  @RequirePermission('documents.post')
  @ApiOperation({ summary: 'Провести. Ошибки — по строкам: «Строка 4: не хватает 2 шт, на складе 3»' })
  post(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDocumentDto) {
    return this.docs.post(id, dto.version, { confirmDuplicateInvoice: dto.confirmDuplicateInvoice });
  }

  @Post(':id/unpost')
  @HttpCode(200)
  @RequirePermission('documents.unpost')
  @ApiOperation({ summary: 'Отменить проведение' })
  unpost(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDocumentDto) {
    return this.docs.unpost(id, dto.version);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('stock.writeoff_approve')
  @ApiOperation({ summary: 'Согласовать списание сверх порога' })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostDocumentDto) {
    return this.docs.approve(id, dto.version);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequireAnyPermission('stock.transfer', 'stock.receive')
  @ApiOperation({ summary: 'Перемещение: принять на складе-получателе (меньше отправленного — акт расхождения)' })
  accept(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcceptTransferDto) {
    return this.transfers.accept(id, dto.version, dto.lines);
  }

  @Post(':id/deletion-mark')
  @HttpCode(200)
  @RequirePermission('documents.write')
  @ApiQuery({ name: 'version', type: Number })
  @ApiQuery({ name: 'mark', type: Boolean })
  mark(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number, @Query('mark') mark = 'true') {
    return this.docs.setDeletionMark(id, version, mark !== 'false');
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('documents.write')
  @ApiQuery({ name: 'version', type: Number })
  @ApiOperation({ summary: 'Удалить черновик' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query('version', ParseIntPipe) version: number) {
    await this.docs.remove(id, version);
  }

  @Post(':id/based-on')
  @RequirePermission('documents.write')
  @ApiOperation({ summary: 'Создать на основании (приёмка → перемещение, …)' })
  basedOn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BasedOnDto) {
    this.docs.assertTypePermission(dto.type);
    return this.docs.createBasedOn(id, dto.type);
  }

  @Post(':id/attachments')
  @RequirePermission('documents.write')
  @ApiOperation({ summary: 'Вложение: фото накладной, скриншот (файл загружается через POST /files)' })
  attach(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.docs.addAttachment(id, dto.fileId);
  }

  @Get(':id/labels.pdf')
  @RequireAnyPermission('stock.labels', 'stock.receive')
  @ApiQuery({ name: 'mode', required: false, enum: ['all', 'without_barcode', 'unpack'] })
  @ApiQuery({ name: 'w', required: false, description: 'Ширина этикетки, мм (58)' })
  @ApiQuery({ name: 'h', required: false, description: 'Высота, мм (40)' })
  @ApiOperation({ summary: 'Этикетки по документу в PDF (товарам без штрихкода выдаётся внутренний EAN-13)' })
  async labelsPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('mode') mode: 'all' | 'without_barcode' | 'unpack' = 'all',
    @Query('w') w = '58',
    @Query('h') h = '40',
    @Res({ passthrough: true }) res: Response,
  ) {
    const pdf = await this.labels.forDocument(id, mode, { w: clamp(Number(w), 30, 120), h: clamp(Number(h), 20, 100) });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="labels.pdf"' });
    return new StreamableFile(pdf);
  }
}

const clamp = (v: number, a: number, b: number) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { extname, join, resolve, sep } from 'path';
import { AppConfig } from '../../config/app.config';
import { Errors } from '../../common/errors/app.exception';
import { TenantTransaction } from '../../database/tenant/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { StoredFile } from './entities/file.entity';

export const FILE_PURPOSES = ['logo', 'product_photo', 'attachment', 'import', 'receipt_screenshot', 'request_photo', 'ocr', 'other'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

const ALLOWED: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/heic': ['.heic'],
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt', '.csv'],
  'application/vnd.ms-excel': ['.xls', '.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/json': ['.json'],
};

/** Файлы магазина на локальном диске: uploads/{tenantId}/ГГГГ/ММ/uuid.ext (ТЗ 2.1). */
@Injectable()
export class FilesService {
  private readonly root: string;

  constructor(
    private readonly config: AppConfig,
    private readonly tenantTx: TenantTransaction,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
  ) {
    this.root = resolve(this.config.uploadsDir);
  }

  async save(
    file: Express.Multer.File | undefined,
    meta: { purpose: FilePurpose; entityType?: string; entityId?: string },
  ): Promise<StoredFile> {
    if (!file) throw Errors.bad('NO_FILE', 'Файл не передан');
    const ext = extname(file.originalname).toLowerCase();
    const allowedExt = ALLOWED[file.mimetype];
    if (!allowedExt || !allowedExt.includes(ext)) {
      throw Errors.bad('FILE_TYPE', 'Недопустимый тип файла', { mime: file.mimetype, ext });
    }
    if (file.mimetype.startsWith('image/') && !looksLikeImage(file.buffer, file.mimetype)) {
      throw Errors.bad('FILE_TYPE', 'Содержимое файла не похоже на изображение');
    }
    return this.tenantTx.run(async (tx) => {
      const now = new Date();
      const rel = [tx.tenantId, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${randomUUID()}${ext}`].join('/');
      const abs = this.absPath(rel, tx.tenantId);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, file.buffer, { flag: 'wx' });
      const stored = await tx.repo(StoredFile).insert({
        purpose: meta.purpose,
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 300),
        mime: file.mimetype,
        size: file.size,
        storagePath: rel,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        entityType: meta.entityType ?? null,
        entityId: meta.entityId ?? null,
      });
      await this.audit.log(tx, {
        action: 'file.upload',
        entityType: 'file',
        entityId: stored.id,
        summary: stored.originalName,
      });
      return stored;
    });
  }

  async meta(id: string) {
    return this.tenantTx.repo(StoredFile, 'Файл').getById(id);
  }

  /** Поток файла. Чужой id → 404 (TenantRepository). */
  async open(id: string, tenantIdOverride?: string) {
    const f = await this.tenantTx.run((tx) => tx.repo(StoredFile, 'Файл').getById(id), tenantIdOverride ? { tenantId: tenantIdOverride, userId: null } : {});
    const abs = this.absPath(f.storagePath, f.tenantId);
    if (!existsSync(abs)) throw Errors.notFound('Файл');
    return { file: f, stream: createReadStream(abs) };
  }

  /** Абсолютный путь файла магазина (для импорта). */
  pathOf(f: StoredFile): string {
    return this.absPath(f.storagePath, f.tenantId);
  }

  async remove(id: string) {
    await this.tenantTx.run(async (tx) => {
      const f = await tx.repo(StoredFile, 'Файл').getById(id);
      await tx.repo(StoredFile).softDelete(id);
      await this.audit.log(tx, { action: 'file.delete', entityType: 'file', entityId: id, summary: f.originalName });
    });
    // Сам файл на диске удаляется ночной очисткой через 30 дней (корзина, ТЗ 22.3)
  }

  /** Короткая ссылка на 10 минут — для <img src> без заголовка Authorization. */
  async signedLink(id: string) {
    const f = await this.meta(id);
    const token = this.jwt.sign({ typ: 'file', fid: f.id, tid: f.tenantId }, { expiresIn: '10m' });
    return { url: `/api/files/public/${token}`, expiresInSec: 600 };
  }

  verifyLink(token: string): { fid: string; tid: string } {
    try {
      const p = this.jwt.verify<{ typ: string; fid: string; tid: string }>(token);
      if (p.typ !== 'file') throw new Error();
      return p;
    } catch {
      throw Errors.notFound('Файл');
    }
  }

  private absPath(rel: string, tenantId: string): string {
    const abs = resolve(this.root, rel);
    const tenantRoot = resolve(this.root, tenantId) + sep;
    if (!abs.startsWith(tenantRoot)) throw Errors.notFound('Файл'); // защита от ../
    return abs;
  }
}

function looksLikeImage(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false;
  switch (mime) {
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8;
    case 'image/png':
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return buf.subarray(0, 3).toString() === 'GIF';
    case 'image/webp':
      return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    case 'image/heic':
      return buf.subarray(4, 8).toString() === 'ftyp';
    default:
      return false;
  }
}

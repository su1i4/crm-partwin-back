import { Injectable } from '@nestjs/common';
import bwipjs from 'bwip-js';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter = require('pdfmake');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vfsRaw = require('pdfmake/build/vfs_fonts');

const vfs: Record<string, string> = vfsRaw.pdfMake ? vfsRaw.pdfMake.vfs : vfsRaw;
const font = (name: string) => Buffer.from(vfs[name], 'base64');

/** PDF на сервере (pdfmake, Roboto с кириллицей) и штрихкоды картинкой (bwip-js). */
@Injectable()
export class PdfService {
  private readonly printer = new PdfPrinter({
    Roboto: {
      normal: font('Roboto-Regular.ttf'),
      bold: font('Roboto-Medium.ttf'),
      italics: font('Roboto-Italic.ttf'),
      bolditalics: font('Roboto-MediumItalic.ttf'),
    },
  });

  render(def: TDocumentDefinitions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = this.printer.createPdfKitDocument({ defaultStyle: { font: 'Roboto' }, ...def });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }

  /** PNG штрихкода (data URL) для вставки в PDF. EAN-13 — если подходит, иначе Code128. */
  async barcode(code: string): Promise<string> {
    const isEan = /^\d{13}$/.test(code);
    const png = await bwipjs.toBuffer({
      bcid: isEan ? 'ean13' : 'code128',
      text: code,
      scale: 3,
      height: 10,
      includetext: true,
      textxalign: 'center',
    });
    return `data:image/png;base64,${png.toString('base64')}`;
  }
}

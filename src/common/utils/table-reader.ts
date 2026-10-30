import ExcelJS from 'exceljs';
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import * as iconv from 'iconv-lite';

export type Cell = string;

/**
 * Чтение Excel (.xlsx потоково) и CSV (разделитель ; , или таб, кодировка UTF-8 или Windows-1251 — выгрузки 1С).
 * onRow получает номер строки файла (с 1) и значения ячеек строками.
 */
export async function readTable(
  path: string,
  kind: 'xlsx' | 'csv',
  onRow: (rowNo: number, cells: Cell[]) => Promise<boolean | void> | boolean | void,
): Promise<void> {
  if (kind === 'xlsx') {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(createReadStream(path), {
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      worksheets: 'emit',
    });
    for await (const sheet of reader) {
      for await (const row of sheet) {
        const values = (row.values as unknown[]).slice(1).map(cellToString);
        if ((await onRow(row.number, values)) === false) return;
      }
      return; // только первый лист
    }
    return;
  }
  const buf = await readFile(path);
  const text = decode(buf);
  const lines = splitCsv(text);
  for (let i = 0; i < lines.length; i++) {
    if ((await onRow(i + 1, lines[i])) === false) return;
  }
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (o.richText) return o.richText.map((r: any) => r.text).join('').trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (o.result !== undefined) return String(o.result).trim();
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

function decode(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const utf = buf.toString('utf8');
  // Битые последовательности UTF-8 → скорее всего Windows-1251
  if (utf.includes('�')) return iconv.decode(buf, 'win1251');
  return utf;
}

function splitCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delims = [';', ',', '\t'];
  const delim = delims.map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(cell.trim());
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export function tableKind(fileName: string, mime: string): 'xlsx' | 'csv' | null {
  const n = fileName.toLowerCase();
  if (n.endsWith('.xlsx') || mime.includes('spreadsheetml')) return 'xlsx';
  if (n.endsWith('.csv') || n.endsWith('.txt') || mime.startsWith('text/')) return 'csv';
  return null;
}

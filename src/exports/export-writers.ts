
import type { ExportCell } from './export-registry.js';

export const CSV_MIME = 'text/csv';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Cell text for CSV. Values starting with `= + - @` (or tab/CR) are prefixed
 * with `'` so spreadsheet apps never evaluate them as formulas (CSV injection).
 */
export function csvCell(value: ExportCell): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 with BOM (Excel needs it for Arabic) and CRLF line endings. */
export function toCsv(headers: string[], rows: ExportCell[][]): Buffer {
  const lines = [headers, ...rows].map((row) => row.map((cell) => csvCell(cell)).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function toXlsx(sheetName: string, headers: string[], rows: ExportCell[][]): Promise<Buffer> {
  // Loaded on first use: exceljs is heavy and most requests never need it.
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Eventor';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.addRow(headers).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of rows) {
    // exceljs writes strings as shared strings (never formulas), so no escaping is needed.
    sheet.addRow(row.map((cell) => (cell === null ? '' : cell)));
  }
  sheet.columns.forEach((column, index) => {
    column.width = Math.min(60, Math.max(10, headers[index]!.length + 2));
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

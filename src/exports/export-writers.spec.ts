import ExcelJS from 'exceljs';
import { csvCell, toCsv, toXlsx } from './export-writers.js';

describe('export writers', () => {
  it('escapes CSV cells and neutralises formulas', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(true)).toBe('true');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-5 DZD')).toBe("'-5 DZD");
    expect(csvCell(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09-15T10:00:00.000Z');
  });

  it('writes a BOM, a header and CRLF rows', () => {
    const csv = toCsv(['code', 'name'], [[16, 'الجزائر'], [31, 'Oran']]).toString('utf8');
    expect(csv).toBe('\uFEFFcode,name\r\n16,الجزائر\r\n31,Oran\r\n');
  });

  it('writes a readable xlsx workbook', async () => {
    const buffer = await toXlsx('wilayas', ['code', 'name'], [[16, 'Alger']]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('wilayas')!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'code', 'name']);
    expect(sheet.getRow(2).values).toEqual([undefined, 16, 'Alger']);
  });
});

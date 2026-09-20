/** Columns of the communes import file (LOC-02), in order. `postal_code` may be left out. */
export const COMMUNES_CSV_COLUMNS = ['wilaya_code', 'name', 'name_ar', 'postal_code'] as const;
export const COMMUNES_CSV_MAX_ROWS = 5_000;
export const COMMUNES_CSV_MAX_BYTES = 2 * 1024 * 1024;

export const COMMUNES_CSV_TEMPLATE =
  '\uFEFFwilaya_code,name,name_ar,postal_code\r\n16,Bab El Oued,باب الوادي,16009\r\n31,Bir El Djir,بئر الجير,31130\r\n';

export interface CommuneCsvRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  wilayaCode: number;
  name: string;
  nameAr: string;
  /** null when the cell is empty (keeps the current postal code on update). */
  postalCode: string | null;
}

export interface CsvLineError {
  line: number;
  message: string;
}

export type CommunesCsvParseResult =
  | { ok: true; rows: CommuneCsvRow[]; errors: CsvLineError[] }
  | { ok: false; reason: 'header'; received: string[] }
  | { ok: false; reason: 'too_many_rows'; count: number };

/**
 * RFC 4180 records: quoted fields may contain commas, quotes (`""`) and line
 * breaks. Returns each record with the line it starts on. A UTF-8 BOM is ignored.
 */
export function parseCsvRecords(text: string): { line: number; fields: string[] }[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endField = () => {
    fields.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted && field.trim() === '') {
      inQuotes = true;
      fieldStarted = true;
      field = '';
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += char;
      if (char.trim() !== '') fieldStarted = true;
    }
  }
  if (field !== '' || fields.length > 0) endRecord();

  // Blank lines are not records.
  return records.filter((r) => !(r.fields.length === 1 && r.fields[0]!.trim() === ''));
}

/** Parses and checks the communes file line by line; bad lines become `errors`, good ones `rows`. */
export function parseCommunesCsv(text: string, maxRows = COMMUNES_CSV_MAX_ROWS): CommunesCsvParseResult {
  const records = parseCsvRecords(text);
  const header = (records[0]?.fields ?? []).map((h) => h.trim().toLowerCase());
  const headerOk =
    (header.length === 3 || header.length === 4) &&
    header.every((column, index) => column === COMMUNES_CSV_COLUMNS[index]);
  if (!headerOk) return { ok: false, reason: 'header', received: header };

  const data = records.slice(1);
  if (data.length > maxRows) return { ok: false, reason: 'too_many_rows', count: data.length };

  const rows: CommuneCsvRow[] = [];
  const errors: CsvLineError[] = [];
  for (const record of data) {
    const [code = '', name = '', nameAr = '', postal = ''] = record.fields.map((f) => f.trim());
    const problems: string[] = [];
    if (record.fields.length > header.length) problems.push(`expected ${header.length} columns, got ${record.fields.length}`);
    const wilayaCode = /^\d{1,3}$/.test(code) ? Number(code) : NaN;
    if (!Number.isInteger(wilayaCode) || wilayaCode < 1 || wilayaCode > 255) problems.push('wilaya_code must be a wilaya number');
    if (name === '') problems.push('name is required');
    else if (name.length > 120) problems.push('name must be at most 120 characters');
    if (nameAr === '') problems.push('name_ar is required');
    else if (nameAr.length > 120) problems.push('name_ar must be at most 120 characters');
    if (postal !== '' && !/^\d{5}$/.test(postal)) problems.push('postal_code must have 5 digits');

    if (problems.length > 0) {
      errors.push({ line: record.line, message: problems.join('; ') });
    } else {
      rows.push({ line: record.line, wilayaCode, name, nameAr, postalCode: postal === '' ? null : postal });
    }
  }
  return { ok: true, rows, errors };
}

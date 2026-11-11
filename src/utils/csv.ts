// Minimal RFC 4180 CSV parser/serialiser. Handles quoted fields, "" escapes, CRLF/LF and a UTF-8 BOM.
// ponytail: hand-rolled to avoid a dependency; swap for csv-parse if streaming of very large files is needed.

export function parseCsvRecords(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Header names are lower-cased and trimmed; cell values are trimmed. */
export function parseCsv(text: string): ParsedCsv {
  const [header, ...rest] = parseCsvRecords(text);
  if (!header) return { headers: [], rows: [] };
  const headers = header.map((h) => h.trim().toLowerCase());
  const rows = rest.map((record) =>
    Object.fromEntries(headers.map((h, idx) => [h, (record[idx] ?? '').trim()])),
  );
  return { headers, rows };
}

/**
 * Serialises one cell for export. Quotes when needed and neutralises spreadsheet formula
 * injection by prefixing cells that start with = + - @ or a tab/CR with a single quote.
 */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

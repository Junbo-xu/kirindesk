/**
 * Pure, zero-dependency CSV serialization for the data-export module (plan
 * §3.6/§4). No DB, no framework — just rows in, a UTF-8 CSV Buffer out. Shared
 * by the reports and audit exporters.
 *
 * Two safety concerns are handled here, in one tested place:
 *  - RFC 4180 escaping: fields containing comma / double-quote / CR / LF are
 *    wrapped in double-quotes with inner quotes doubled (plan §4.2).
 *  - CSV formula injection: a TEXT cell whose first character is one of
 *    = + - @ TAB CR could be executed as a formula when opened in Excel/Sheets,
 *    so it is neutralized with a leading apostrophe. NUMERIC cells (server-
 *    generated counts / decimals / ids) are exempt, so a negative amount like
 *    -123.45 stays a number rather than becoming text (plan §4.3).
 */

// Formats supported this phase. Excel (.xlsx) is deferred (plan §4.1/§4.7).
export const EXPORT_FORMATS = ['csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// A serialized export ready to stream to the client.
export interface ExportFile {
  filename: string;
  mime: string;
  body: Buffer;
}

// One CSV cell. `numeric` marks server-generated numbers (counts, decimals,
// ids) that must NOT be formula-neutralized.
export interface CsvCell {
  value: string;
  numeric: boolean;
}

/** A text cell (formula-injection neutralized). null/undefined → empty. */
export function txt(value: string | null | undefined): CsvCell {
  return { value: value ?? '', numeric: false };
}

/** A numeric cell (exempt from neutralization). null/undefined → empty. */
export function num(value: string | number | null | undefined): CsvCell {
  return { value: value == null ? '' : String(value), numeric: true };
}

/** A blank separator row (renders as one empty CSV line). */
export const BLANK_ROW: CsvCell[] = [txt('')];

export interface ExportWatermarkActor {
  tenantId: string;
  userId: string;
}

export function exportWatermarkRows(actor: ExportWatermarkActor, exportedAt: Date): CsvCell[][] {
  return [
    [txt('水印'), txt('KirinDesk 授权导出，禁止未授权转发')],
    [txt('租户'), txt(actor.tenantId)],
    [txt('导出人'), txt(actor.userId)],
    [txt('导出时间'), txt(exportedAt.toISOString())],
  ];
}

const INJECTION_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

function neutralize(value: string): string {
  if (value.length > 0 && INJECTION_PREFIXES.includes(value[0])) {
    return `'${value}`;
  }
  return value;
}

function escapeField(cell: CsvCell): string {
  const raw = cell.numeric ? cell.value : neutralize(cell.value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Serializes rows to a CSV Buffer: UTF-8 with a leading BOM (so Excel detects
 * the encoding and renders non-ASCII correctly, plan §4.2) and CRLF line
 * endings (RFC 4180). Each row may have its own column count — preamble rows
 * and data rows need not align.
 */
export function serializeCsv(rows: CsvCell[][]): Buffer {
  const body = rows.map((row) => row.map(escapeField).join(',')).join('\r\n');
  // Leading BOM (U+FEFF → EF BB BF in UTF-8); trailing CRLF for a clean final line.
  return Buffer.from(`\uFEFF${body}\r\n`, 'utf8');
}

export const CSV_MIME = 'text/csv; charset=utf-8';

// Compact UTC timestamp for filenames: 20260625T120000Z (no colons/dashes,
// which are awkward/illegal in filenames). Server-side Date is fine here.
export function exportTimestamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

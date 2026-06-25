import { describe, expect, it } from 'vitest';
import { BLANK_ROW, CsvCell, exportTimestamp, num, serializeCsv, txt } from './export-csv';

// Strips the leading BOM and trailing CRLF, returns the body text.
function decode(buf: Buffer): string {
  return buf
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n$/, '');
}

describe('export-csv serializer', () => {
  it('prepends a UTF-8 BOM and ends with CRLF', () => {
    const buf = serializeCsv([[txt('a')]]);
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    expect(buf.toString('utf8').endsWith('\r\n')).toBe(true);
  });

  it('joins rows with CRLF', () => {
    const buf = serializeCsv([
      [txt('a'), txt('b')],
      [txt('c'), txt('d')],
    ]);
    expect(decode(buf)).toBe('a,b\r\nc,d');
  });

  it('RFC 4180 escapes comma, double-quote, and newline', () => {
    const buf = serializeCsv([[txt('a,b'), txt('he"llo'), txt('line\nbreak')]]);
    // comma → quoted; inner quote → doubled + quoted; newline → quoted.
    expect(decode(buf)).toBe('"a,b","he""llo","line\nbreak"');
  });

  it('neutralizes formula-injection prefixes on TEXT cells', () => {
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
      const cell = decode(serializeCsv([[txt(`${prefix}cmd`)]]));
      // An apostrophe is prepended right before the dangerous prefix char. (CR
      // additionally triggers RFC 4180 quoting, so the field may be wrapped in
      // quotes — assert the neutralization, not the outer quoting.)
      expect(cell).toContain(`'${prefix}cmd`);
    }
  });

  it('does NOT neutralize NUMERIC cells (negative amounts stay numbers)', () => {
    const buf = serializeCsv([[num('-123.45'), num(0), num('1000.00')]]);
    expect(decode(buf)).toBe('-123.45,0,1000.00');
  });

  it('renders null/undefined as empty fields', () => {
    const buf = serializeCsv([[txt(null), txt(undefined), num(null), num(undefined)]]);
    expect(decode(buf)).toBe(',,,');
  });

  it('BLANK_ROW renders as one empty line', () => {
    const buf = serializeCsv([[txt('a')], BLANK_ROW, [txt('b')]]);
    expect(decode(buf)).toBe('a\r\n\r\nb');
  });

  it('allows ragged rows (preamble vs data column counts differ)', () => {
    const rows: CsvCell[][] = [
      [txt('报表'), txt('销售汇总')],
      [txt('x'), num(1), num('2.00'), num(0)],
    ];
    expect(decode(serializeCsv(rows))).toBe('报表,销售汇总\r\nx,1,2.00,0');
  });

  it('exportTimestamp is filename-safe (no colons/dashes, ends Z)', () => {
    const ts = exportTimestamp(new Date('2026-06-25T13:21:28.182Z'));
    expect(ts).toBe('20260625T132128Z');
    expect(ts).not.toMatch(/[-:]/);
  });
});

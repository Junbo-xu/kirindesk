import type { Response } from 'express';
import { ExportFile } from './export-csv';

/**
 * Writes an in-memory export as an attachment download (plan §3.3). Sets the
 * content type, a CR/LF-stripped `filename=` plus an RFC 5987 `filename*` for
 * non-ASCII safety, and `Cache-Control: no-store` (an authorized export must
 * not be cached by intermediaries).
 */
export function sendExportFile(res: Response, file: ExportFile): void {
  const safeName = file.filename.replace(/["\r\n]/g, '_');
  res.setHeader('Content-Type', file.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  );
  res.setHeader('Content-Length', file.body.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.body);
}

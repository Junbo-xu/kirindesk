import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { FilesService } from './files.service';
import { InvalidDownloadTokenException } from './files.errors';

/**
 * Public, unauthenticated download endpoint. Authentication is the bearer
 * download token (single-use, short-lived, hashed at rest) — NOT a JWT — so
 * this controller deliberately has no TenantAuthGuard/PermissionGuard. Every
 * invalid/expired/used token maps to one generic 404 (InvalidDownloadToken).
 */
@Controller('api/files')
export class FileDownloadController {
  constructor(private readonly filesService: FilesService) {}

  @Get('download')
  async download(@Query('token') token: string, @Res() res: Response): Promise<void> {
    if (!token) {
      throw new InvalidDownloadTokenException();
    }
    const target = await this.filesService.resolveDownload(token);

    res.setHeader('Content-Type', target.mimeType);
    res.setHeader('Content-Length', target.sizeBytes);
    // Quote the filename and strip any CR/LF to avoid header injection.
    const safeName = target.fileName.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    // Downloads carry a one-time token; never cache.
    res.setHeader('Cache-Control', 'no-store');

    target.stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    target.stream.pipe(res);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService, RequestActor } from './files.service';
import { QuotaGuard } from '../subscription/quota.guard';
import { ListFilesQuery } from './dto/list-files.query';
import { UploadFileDto } from './dto/upload-file.dto';
import { ALLOWED_MIME_TYPES, MAX_FILE_BYTES } from './files.constants';
import {
  FileTooLargeException,
  NoFileUploadedException,
  UnsupportedFileTypeException,
} from './files.errors';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

type MulterFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@Controller('api/files')
@UseGuards(TenantAuthGuard, PermissionGuard, QuotaGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('files', 'upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  )
  async upload(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @UploadedFile() file: MulterFile | undefined,
    @Body() dto: UploadFileDto,
  ) {
    if (!file) {
      throw new NoFileUploadedException();
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new FileTooLargeException(MAX_FILE_BYTES);
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedFileTypeException(file.mimetype);
    }
    return this.filesService.upload(this.actor(user, req), {
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      purpose: dto.purpose,
    });
  }

  @Get()
  @RequirePermission('files', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListFilesQuery,
  ) {
    return this.filesService.list(this.actor(user, req), query);
  }

  @Get(':id')
  @RequirePermission('files', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.filesService.getOne(this.actor(user, req), id);
  }

  @Post(':id/token')
  @RequirePermission('files', 'download')
  async createToken(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.filesService.createDownloadToken(this.actor(user, req), id);
  }

  @Delete(':id')
  @RequirePermission('files', 'delete')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.filesService.remove(this.actor(user, req), id);
    return { id, deleted: true };
  }
}

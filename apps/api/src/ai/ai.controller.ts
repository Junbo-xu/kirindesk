import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService, RequestActor } from './ai.service';
import { QuotaGuard } from '../subscription/quota.guard';
import { CheckQuota } from '../subscription/quota.service';
import { ModuleGuard, RequireModule } from '../subscription/module.guard';
import { OcrExtractRequestDto } from './dto/ocr-extract-request.dto';
import { AiCompleteRequestDto } from './dto/ai-complete-request.dto';
import { ListInvocationsQuery } from './dto/list-invocations.query';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

/**
 * AI/OCR endpoints. Every route runs under tenant auth + RBAC; reads/writes are
 * tenant-isolated by RLS and further narrowed by dataScope in the service
 * (plan §6.4/§7). No update/delete routes — invocation records are append-only
 * (plan §7.5).
 */
@Controller('api/ai')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard, QuotaGuard)
@RequireModule('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  // ---- OCR ----

  @Post('ocr')
  @CheckQuota('ai')
  @RequirePermission('ocr', 'process')
  async ocrExtract(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: OcrExtractRequestDto,
  ) {
    return this.aiService.ocrExtract(this.actor(user, req), {
      fileId: dto.fileId,
      docType: dto.docType,
      timeoutMs: dto.options?.timeoutMs,
      languages: dto.options?.languages,
    });
  }

  @Get('ocr')
  @RequirePermission('ocr', 'view')
  async listOcr(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListInvocationsQuery,
  ) {
    return this.aiService.list(this.actor(user, req), 'ocr', query);
  }

  @Get('ocr/:id')
  @RequirePermission('ocr', 'view')
  async getOcr(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.aiService.getOne(this.actor(user, req), 'ocr', id);
  }

  // ---- AI completion ----

  @Post('complete')
  @UseGuards(QuotaGuard)
  @CheckQuota('ai')
  @RequirePermission('ai', 'process')
  async aiComplete(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: AiCompleteRequestDto,
  ) {
    return this.aiService.aiComplete(this.actor(user, req), {
      task: dto.task,
      input: dto.input,
      timeoutMs: dto.options?.timeoutMs,
      maxOutputTokens: dto.options?.maxOutputTokens,
    });
  }

  @Get('complete')
  @RequirePermission('ai', 'view')
  async listAi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListInvocationsQuery,
  ) {
    return this.aiService.list(this.actor(user, req), 'ai', query);
  }

  @Get('complete/:id')
  @RequirePermission('ai', 'view')
  async getAi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.aiService.getOne(this.actor(user, req), 'ai', id);
  }
}

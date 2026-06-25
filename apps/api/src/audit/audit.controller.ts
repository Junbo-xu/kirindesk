import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditQueryService, RequestActor } from './audit-query.service';
import { AuditExportService } from './audit-export.service';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';
import { AuditExportQuery } from './dto/audit-export.query';
import { sendExportFile } from '../common/export-response';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

/**
 * Read-only audit-log viewer (plan §3). Every route runs under tenant auth +
 * RBAC (`audit_logs:view`); reads are tenant-isolated by RLS and narrowed by
 * dataScope in the service. There are NO write routes — audit_logs is
 * append-only and the app role is REVOKE-d UPDATE/DELETE at the database layer
 * (migrations 022/023). Viewing audit does not itself write audit (plan §3.5).
 */
@Controller('api/audit-logs')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class AuditController {
  constructor(
    private readonly auditQueryService: AuditQueryService,
    private readonly auditExportService: AuditExportService,
  ) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get()
  @RequirePermission('audit_logs', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListAuditLogsQuery,
  ) {
    return this.auditQueryService.list(this.actor(user, req), query);
  }

  // CSV export of the same filtered list (plan §3). Static route declared
  // before :id (and :id constrained to digits) so 'export' is never parsed as
  // an id. @Res so we stream the file ourselves with download headers.
  @Get('export')
  @RequirePermission('audit_logs', 'view')
  async export(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: AuditExportQuery,
    @Res() res: Response,
  ) {
    const file = await this.auditExportService.exportLogs(this.actor(user, req), query);
    sendExportFile(res, file);
  }

  // Static route declared BEFORE :id (and :id constrained to digits) so 'chain'
  // is never mis-parsed as an id (plan §3.1). The chain_key is derived
  // server-side; this endpoint takes no chain_key input (plan §4.1.2).
  @Get('chain/verify')
  @RequirePermission('audit_logs', 'view')
  async verifyChain(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.auditQueryService.verifyTenantChain(this.actor(user, req));
  }

  // :id is a bigint constrained to digits — passed through as a string to avoid
  // JS number precision loss; non-numeric paths fall through to 404 (plan §3.1).
  @Get(':id(\\d+)')
  @RequirePermission('audit_logs', 'view')
  async getOne(@CurrentUser() user: TenantJwtUser, @Req() req: Request, @Param('id') id: string) {
    return this.auditQueryService.getOne(this.actor(user, req), id);
  }
}

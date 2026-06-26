import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { PlatformAuthGuard } from '../platform-auth/platform-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformSupportService } from './platform-support.service';
import { SupportAccessGuard, RequestWithSupportGrant, SupportGrant } from './support-access.guard';
import { ListAuditLogsQuery } from '../audit/dto/list-audit-logs.query';
import { ListUsersQuery } from '../users/dto/list-users.query';

interface PlatformJwtUser {
  sub: string;
  email: string;
}

/**
 * Platform-side authorized read access (plan §3.1/§3.4). Platform identity only
 * (PlatformAuthGuard) — not tenant RBAC, not the tenant-status gate. The own-
 * grants route needs no per-tenant authorization. Every :tenantId read adds
 * SupportAccessGuard, which requires an active grant naming this admin for that
 * tenant (else 403) and stashes the grant on the request. There are ONLY GET
 * routes here — scope=read_only is structural (plan §3.4).
 */
@Controller('api/platform/support')
@UseGuards(PlatformAuthGuard)
export class PlatformSupportController {
  constructor(private readonly service: PlatformSupportService) {}

  private grant(req: RequestWithSupportGrant): SupportGrant {
    // Always present: SupportAccessGuard ran on these routes and would have
    // thrown 403 otherwise.
    return req.supportGrant!;
  }

  // "Which tenants named me?" — no tenant context, no audit (plan §3.6).
  @Get('grants')
  async myGrants(@CurrentUser() user: PlatformJwtUser) {
    return this.service.listMyGrants(user.sub);
  }

  // Static chain/verify declared BEFORE the :id route so it is never parsed as
  // an id; :id constrained to digits (audit ids are bigints).
  @Get('tenants/:tenantId/audit-logs/chain/verify')
  @UseGuards(SupportAccessGuard)
  async verifyChain(@CurrentUser() user: PlatformJwtUser, @Req() req: RequestWithSupportGrant) {
    return this.service.verifyAuditChain(user.sub, this.grant(req));
  }

  @Get('tenants/:tenantId/audit-logs/:id(\\d+)')
  @UseGuards(SupportAccessGuard)
  async getAuditLog(
    @CurrentUser() user: PlatformJwtUser,
    @Req() req: RequestWithSupportGrant,
    @Param('id') id: string,
  ) {
    return this.service.getAuditLog(user.sub, this.grant(req), id);
  }

  @Get('tenants/:tenantId/audit-logs')
  @UseGuards(SupportAccessGuard)
  async listAuditLogs(
    @CurrentUser() user: PlatformJwtUser,
    @Req() req: RequestWithSupportGrant,
    @Query() query: ListAuditLogsQuery,
  ) {
    return this.service.listAuditLogs(user.sub, this.grant(req), query);
  }

  @Get('tenants/:tenantId/users')
  @UseGuards(SupportAccessGuard)
  async listUsers(
    @CurrentUser() user: PlatformJwtUser,
    @Req() req: RequestWithSupportGrant,
    @Query() query: ListUsersQuery,
  ) {
    return this.service.listUsers(user.sub, this.grant(req), query);
  }

  @Get('tenants/:tenantId/roles')
  @UseGuards(SupportAccessGuard)
  async listRoles(@CurrentUser() user: PlatformJwtUser, @Req() req: RequestWithSupportGrant) {
    return this.service.listRoles(user.sub, this.grant(req));
  }
}

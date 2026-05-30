import { Controller, Post, Get, Body, Req, UseGuards, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TenantAuthGuard } from './tenant-auth.guard';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Request } from 'express';

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string; tenantSlug: string },
    @Req() req: Request,
  ) {
    return this.authService.login(body.email, body.password, body.tenantSlug, {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
  }

  @Post('logout')
  @UseGuards(TenantAuthGuard)
  @HttpCode(200)
  async logout(@CurrentUser() user: { sub: string; tenantId: string }, @Req() req: Request) {
    await this.auditService.log({
      tenantId: user.tenantId,
      actorType: 'tenant_user',
      actorId: user.sub,
      action: 'auth:logout',
      resourceType: 'user',
      resourceId: user.sub,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(TenantAuthGuard)
  me(@CurrentUser() user: { sub: string; tenantId: string; email: string }) {
    return { id: user.sub, email: user.email, tenantId: user.tenantId };
  }
}

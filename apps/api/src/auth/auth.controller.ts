import { Controller, Post, Get, Body, Req, UseGuards, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';
import { TenantAuthGuard } from './tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Request } from 'express';
import { LoginRateLimit, LoginRateLimitGuard } from './login-rate-limit.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginRateLimitGuard)
  @LoginRateLimit('tenant')
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
  async logout(
    @CurrentUser() user: { sub: string; tenantId: string; sid: string },
    @Req() req: Request,
  ) {
    await this.authService.logout(user, {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(TenantAuthGuard)
  me(@CurrentUser() user: { sub: string; tenantId: string; email: string }) {
    return { id: user.sub, email: user.email, tenantId: user.tenantId };
  }
}

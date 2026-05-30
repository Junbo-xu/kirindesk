import { Controller, Post, Get, Body, Req, UseGuards, HttpCode } from '@nestjs/common';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Request } from 'express';

@Controller('api/platform-auth')
export class PlatformAuthController {
  constructor(private readonly platformAuthService: PlatformAuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email: string; password: string }, @Req() req: Request) {
    return this.platformAuthService.login(body.email, body.password, {
      ip: req.ip,
      ua: req.headers['user-agent'],
    });
  }

  @Post('logout')
  @UseGuards(PlatformAuthGuard)
  @HttpCode(200)
  logout() {
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(PlatformAuthGuard)
  me(@CurrentUser() user: { sub: string; email: string }) {
    return { id: user.sub, email: user.email };
  }
}

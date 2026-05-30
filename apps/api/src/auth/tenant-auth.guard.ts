import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class TenantAuthGuard extends AuthGuard('tenant-jwt') {
  handleRequest<T>(err: Error | null, user: T, _info: unknown, _context: ExecutionContext): T {
    if (err || !user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }
}

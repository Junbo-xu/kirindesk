import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class TenantJwtStrategy extends PassportStrategy(Strategy, 'tenant-jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.TENANT_JWT_SECRET || 'tenant-jwt-fallback-dev',
    });
  }

  validate(payload: { sub: string; type: string; tenantId: string; email: string }) {
    if (payload.type !== 'tenant_user') {
      return null;
    }
    return { sub: payload.sub, type: payload.type, tenantId: payload.tenantId, email: payload.email };
  }
}

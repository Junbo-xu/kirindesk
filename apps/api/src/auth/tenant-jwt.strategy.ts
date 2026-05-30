import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';

@Injectable()
export class TenantJwtStrategy extends PassportStrategy(Strategy, 'tenant-jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('TENANT_JWT_SECRET'),
    });
  }

  validate(payload: { sub: string; type: string; tenantId: string; email: string }) {
    if (payload.type !== 'tenant_user') {
      return null;
    }
    return { sub: payload.sub, type: payload.type, tenantId: payload.tenantId, email: payload.email };
  }
}

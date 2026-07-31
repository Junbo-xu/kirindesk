import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';
import { AuthSessionService } from '../auth-session/auth-session.service';

@Injectable()
export class TenantJwtStrategy extends PassportStrategy(Strategy, 'tenant-jwt') {
  constructor(private readonly sessions: AuthSessionService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('TENANT_JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; type: string; tenantId: string; sid?: string }) {
    if (payload.type !== 'tenant_user' || !payload.sid) {
      return null;
    }
    return this.sessions.validateTenantSession(payload.sid, payload.tenantId, payload.sub);
  }
}

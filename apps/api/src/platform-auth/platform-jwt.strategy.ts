import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';
import { AuthSessionService } from '../auth-session/auth-session.service';

@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(Strategy, 'platform-jwt') {
  constructor(private readonly sessions: AuthSessionService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('PLATFORM_JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; type: string; sid?: string }) {
    if (payload.type !== 'platform_admin' || !payload.sid) {
      return null;
    }
    return this.sessions.validatePlatformSession(payload.sid, payload.sub);
  }
}

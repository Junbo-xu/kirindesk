import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';

@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(Strategy, 'platform-jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('PLATFORM_JWT_SECRET'),
    });
  }

  validate(payload: { sub: string; type: string; email: string }) {
    if (payload.type !== 'platform_admin') {
      return null;
    }
    return { sub: payload.sub, type: payload.type, email: payload.email };
  }
}

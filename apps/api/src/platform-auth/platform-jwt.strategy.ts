import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(Strategy, 'platform-jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.PLATFORM_JWT_SECRET || 'platform-jwt-fallback-dev',
    });
  }

  validate(payload: { sub: string; type: string; email: string }) {
    if (payload.type !== 'platform_admin') {
      return null;
    }
    return { sub: payload.sub, type: payload.type, email: payload.email };
  }
}

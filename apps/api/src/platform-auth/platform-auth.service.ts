import { Injectable, Inject, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { randomUUID } from 'node:crypto';
import { AuthSessionService } from '../auth-session/auth-session.service';

const DUMMY_BCRYPT_HASH = bcrypt.hashSync('__dummy_never_match__', 12);

@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly sessions: AuthSessionService,
  ) {}

  async login(email: string, password: string, meta: { ip?: string; ua?: string }) {
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash, name, status FROM platform_admins WHERE email = $1`,
      [email],
    );

    if (rows.length === 0) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      await this.logFailed(email, 'admin_not_found', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    const admin = rows[0];
    if (admin.status !== 'active') {
      await this.logFailed(email, 'admin_disabled', meta);
      throw new ForbiddenException('Account disabled');
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      await this.logFailed(email, 'invalid_password', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionId = randomUUID();
    const payload = {
      sub: admin.id,
      type: 'platform_admin',
      email: admin.email,
      sid: sessionId,
    };
    const accessToken = this.jwtService.sign(payload);
    const decoded = this.jwtService.decode(accessToken) as { exp?: number };
    if (!decoded.exp) throw new Error('Signed platform token has no expiration.');
    await this.sessions.createPlatformSession({
      sessionId,
      actorId: admin.id,
      expiresAt: new Date(decoded.exp * 1000),
      ip: meta.ip,
      userAgent: meta.ua,
    });

    await this.auditService.log({
      tenantId: null,
      actorType: 'platform_admin',
      actorId: admin.id,
      action: 'auth:login_success',
      resourceType: 'platform_admin',
      resourceId: admin.id,
      ipAddress: meta.ip,
      userAgent: meta.ua,
    });

    return { accessToken, admin: { id: admin.id, email: admin.email, name: admin.name } };
  }

  async logout(
    admin: { sub: string; sid: string },
    meta: { ip?: string; ua?: string },
  ): Promise<void> {
    await this.sessions.revokePlatformSession(admin.sid, admin.sub);
    await this.auditService.log({
      tenantId: null,
      actorType: 'platform_admin',
      actorId: admin.sub,
      action: 'auth:logout',
      resourceType: 'platform_admin',
      resourceId: admin.sub,
      metadata: { sessionId: admin.sid },
      ipAddress: meta.ip,
      userAgent: meta.ua,
    });
  }

  private async logFailed(email: string, reason: string, meta: { ip?: string; ua?: string }) {
    await this.auditService
      .log({
        tenantId: null,
        actorType: 'platform_admin',
        actorId: '00000000-0000-0000-0000-000000000000',
        action: 'auth:login_failed',
        resourceType: 'platform_admin',
        resourceId: null,
        metadata: { email, reason },
        ipAddress: meta.ip,
        userAgent: meta.ua,
      })
      .catch(() => {});
  }
}

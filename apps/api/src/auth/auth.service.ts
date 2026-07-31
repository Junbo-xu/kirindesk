import { Injectable, Inject, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { randomUUID } from 'node:crypto';
import { AuthSessionService } from '../auth-session/auth-session.service';

const DUMMY_BCRYPT_HASH = bcrypt.hashSync('__dummy_never_match__', 12);

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly sessions: AuthSessionService,
  ) {}

  async login(
    email: string,
    password: string,
    tenantSlug: string,
    meta: { ip?: string; ua?: string },
  ) {
    const { rows: tenants } = await this.pool.query(
      `SELECT id FROM tenants WHERE slug = $1 AND status = 'active' AND deleted_at IS NULL`,
      [tenantSlug],
    );

    if (tenants.length === 0) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      await this.logFailed(null, email, 'tenant_not_found', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    const tenantId = tenants[0].id as string;
    const user = await this.usersService.findByEmailForAuth(tenantId, email);

    if (!user) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      await this.logFailed(tenantId, email, 'user_not_found', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'active') {
      await this.logFailed(tenantId, email, 'user_disabled', meta);
      throw new ForbiddenException('Account disabled');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await this.logFailed(tenantId, email, 'invalid_password', meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionId = randomUUID();
    const payload = {
      sub: user.id,
      type: 'tenant_user',
      tenantId,
      email: user.email,
      sid: sessionId,
    };
    const accessToken = this.jwtService.sign(payload);
    const decoded = this.jwtService.decode(accessToken) as { exp?: number };
    if (!decoded.exp) throw new Error('Signed tenant token has no expiration.');
    await this.sessions.createTenantSession(tenantId, {
      sessionId,
      actorId: user.id,
      expiresAt: new Date(decoded.exp * 1000),
      ip: meta.ip,
      userAgent: meta.ua,
    });

    await this.auditService.log({
      tenantId,
      actorType: 'tenant_user',
      actorId: user.id,
      action: 'auth:login_success',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: meta.ip,
      userAgent: meta.ua,
    });

    return { accessToken, user: { id: user.id, email: user.email, name: user.name, tenantId } };
  }

  async logout(
    user: { sub: string; tenantId: string; sid: string },
    meta: { ip?: string; ua?: string },
  ): Promise<void> {
    await this.sessions.revokeTenantSession(user.sid, user.tenantId, user.sub);
    await this.auditService.log({
      tenantId: user.tenantId,
      actorType: 'tenant_user',
      actorId: user.sub,
      action: 'auth:logout',
      resourceType: 'user',
      resourceId: user.sub,
      metadata: { sessionId: user.sid },
      ipAddress: meta.ip,
      userAgent: meta.ua,
    });
  }

  private async logFailed(
    tenantId: string | null,
    email: string,
    reason: string,
    meta: { ip?: string; ua?: string },
  ) {
    await this.auditService
      .log({
        tenantId,
        actorType: 'tenant_user',
        actorId: '00000000-0000-0000-0000-000000000000',
        action: 'auth:login_failed',
        resourceType: 'user',
        resourceId: null,
        metadata: { email, reason },
        ipAddress: meta.ip,
        userAgent: meta.ua,
      })
      .catch(() => {});
  }
}

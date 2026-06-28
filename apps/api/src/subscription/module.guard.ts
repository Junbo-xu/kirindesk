import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';

export const REQUIRE_MODULE_KEY = 'require_module';
export const RequireModule = (moduleCode: string) => SetMetadata(REQUIRE_MODULE_KEY, moduleCode);

@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const moduleCode = this.reflector.getAllAndOverride<string>(REQUIRE_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!moduleCode) return true;

    const req = context.switchToHttp().getRequest();
    const tenantId = req.user?.tenantId;
    if (!tenantId) return true;

    const client = await this.pool.connect();
    try {
      // Wrap in a transaction so SET LOCAL persists across the two queries.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      const { rows } = await client.query<{ enabled: boolean }>(
        `SELECT tm.enabled
           FROM tenant_modules tm
           JOIN modules m ON m.id = tm.module_id
          WHERE tm.tenant_id = $1 AND m.code = $2`,
        [tenantId, moduleCode],
      );
      await client.query('COMMIT');
      if (rows.length === 0 || !rows[0].enabled) {
        throw new ForbiddenException({ code: 'MODULE_NOT_ENABLED', module: moduleCode });
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return true;
  }
}

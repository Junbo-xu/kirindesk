import type { Pool } from 'pg';

/**
 * Refuse to start if the runtime database role is a superuser.
 *
 * The runtime must connect via APP_DATABASE_URL (the restricted kirindesk_app
 * role). A superuser bypasses RLS and can disable audit triggers, so running
 * the API with superuser credentials would defeat the tenant isolation and
 * append-only protections. This is a defense-in-depth check against
 * misconfiguration (e.g. APP_DATABASE_URL pointed at DATABASE_URL).
 *
 * The error message never includes the connection string or password.
 */
export async function assertNonSuperuserRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolname: string; is_superuser: boolean }>(
    `SELECT current_user AS rolname, current_setting('is_superuser') = 'on' AS is_superuser`,
  );

  const { rolname, is_superuser } = rows[0];
  if (is_superuser) {
    throw new Error(
      `Runtime database role must not be a superuser (role: ${rolname}). ` +
        `Configure APP_DATABASE_URL to use the restricted application role.`,
    );
  }
}

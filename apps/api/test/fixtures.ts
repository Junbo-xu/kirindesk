import * as bcrypt from 'bcryptjs';
import pg from 'pg';

export const TEST_DB = 'kirindesk_test';

// Fixed identifiers so tests can reference the tenant chain key directly.
export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
export const TEST_ADMIN_ID = '33333333-3333-3333-3333-333333333333';

export const TEST_TENANT_SLUG = 'test-tenant';
export const TEST_USER_EMAIL = 'test-user@test.local';
export const TEST_ADMIN_EMAIL = 'test-admin@test.local';
export const TEST_PASSWORD = 'test-password-123';

export const ZERO_HASH = '0'.repeat(64);

// Writes the minimal fixture into kirindesk_test only. Asserts the connection
// is on the test database before any write. Does NOT reuse the dev seed.
export async function seedFixture(adminConnectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    const guard = await client.query('SELECT current_database() AS db');
    if (guard.rows[0]?.db !== TEST_DB) {
      throw new Error(
        `Refusing to seed: connected to "${guard.rows[0]?.db}", expected "${TEST_DB}"`,
      );
    }

    const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 10);

    await client.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [TEST_TENANT_ID, 'Test Tenant', TEST_TENANT_SLUG],
    );

    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
       VALUES ($1, $2, $3, $4, 'Test User', 'active', true)`,
      [TEST_USER_ID, TEST_TENANT_ID, TEST_USER_EMAIL, passwordHash],
    );

    await client.query(
      `INSERT INTO platform_admins (id, email, password_hash, name, status)
       VALUES ($1, $2, $3, 'Test Admin', 'active')`,
      [TEST_ADMIN_ID, TEST_ADMIN_EMAIL, passwordHash],
    );

    // Audit chains must exist or AuditService silently rolls back its writes.
    await client.query(
      `INSERT INTO audit_log_chains (chain_key, tenant_id, last_hash) VALUES ($1, $2, $3)`,
      [`tenant:${TEST_TENANT_ID}`, TEST_TENANT_ID, ZERO_HASH],
    );
    await client.query(
      `INSERT INTO audit_log_chains (chain_key, tenant_id, last_hash) VALUES ('platform', NULL, $1)`,
      [ZERO_HASH],
    );
  } finally {
    await client.end();
  }
}

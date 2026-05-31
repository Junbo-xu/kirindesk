// Security regression checks for KirinDesk.
//
// Run AFTER `pnpm test:integration` (which builds and seeds kirindesk_test).
// Usage: node scripts/security-regression.mjs   (root: `pnpm test:security`)
//
// Three sections:
//   A. static  — grep the source tree for forbidden patterns
//   B. startup — spawn apps/api/dist/main.js with broken env, expect it to die
//                before listening on the port
//   C. db/rls  — connect to kirindesk_test as the restricted app role and prove
//                audit_logs is append-only and RLS hides rows without context
//
// Pure Node: node:child_process / fs / path + the existing `pg` dependency
// (resolved from apps/api, since pnpm does not hoist it to the repo root).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API_MAIN = resolve(ROOT, 'apps/api/dist/main.js');
const API_PORT = 3001;

// pg lives under apps/api (pnpm isolates node_modules); resolve it from there.
const apiRequire = createRequire(resolve(ROOT, 'apps/api/package.json'));
const pg = apiRequire('pg');

const TEST_DB = 'kirindesk_test';
const DEV_FALLBACK_ADMIN_URL = `postgresql://kirindesk:kirindesk_dev_password@localhost:5432/${TEST_DB}`;
const DEV_FALLBACK_APP_URL = `postgresql://kirindesk_app:kirindesk_app_dev_password@localhost:5432/${TEST_DB}`;
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? DEV_FALLBACK_ADMIN_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL ?? DEV_FALLBACK_APP_URL;

// Fixture identifiers must match apps/api/test/fixtures.ts.
const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
const WRONG_TENANT_ID = '99999999-9999-9999-9999-999999999999';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// A. Static checks
// ---------------------------------------------------------------------------

// grep -rn, returning matching lines (empty array when grep finds nothing).
function grep(pattern, paths, extraArgs = []) {
  const args = ['-rn', ...extraArgs, pattern, ...paths];
  try {
    const out = execFileSync('grep', args, { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter((l) => l.trim() !== '');
  } catch (err) {
    if (err.status === 1) return []; // grep: no matches
    throw err; // status >= 2: real error
  }
}

function staticChecks() {
  // I4: apps/api/src must not read process.env.DATABASE_URL (only APP_*).
  const dbUrl = grep('process.env.DATABASE_URL', ['apps/api/src'], ['--include=*.ts']);
  record('static: apps/api/src does not read process.env.DATABASE_URL', dbUrl.length === 0, dbUrl.join(' | '));

  // I5: no fallback-dev anywhere in source.
  const fb = grep('fallback-dev', ['apps', 'packages'], ['--include=*.ts']);
  record('static: no fallback-dev', fb.length === 0, fb.join(' | '));

  // I6: only TENANT_/PLATFORM_ JWT secrets, never a bare legacy JWT_SECRET.
  const jwt = grep('JWT_SECRET', ['apps', 'packages'], ['--include=*.ts']).filter(
    (l) => !/TENANT_JWT_SECRET|PLATFORM_JWT_SECRET/.test(l),
  );
  record('static: no legacy bare JWT_SECRET', jwt.length === 0, jwt.join(' | '));

  // I14: no hardcoded LETPCBA tenant in code or sql.
  const letpcba = grep('LETPCBA', ['apps', 'packages', 'db'], ['--include=*.ts', '--include=*.sql']);
  record('static: no LETPCBA hardcoded', letpcba.length === 0, letpcba.join(' | '));

  // I15: .env must not be git-tracked (empty stdout == untracked).
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', '.env'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    tracked = '';
  }
  record('static: .env is not git-tracked', tracked === '', tracked);
}

// ---------------------------------------------------------------------------
// B. Startup failure checks
// ---------------------------------------------------------------------------

function isPortListening(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      res(true);
    });
    sock.on('error', () => res(false));
    sock.setTimeout(1000, () => {
      sock.destroy();
      res(false);
    });
  });
}

// Env that WOULD let the API boot, minus whatever the caller overrides.
function baseEnv() {
  return {
    ...process.env,
    TENANT_JWT_SECRET: 'test-tenant-jwt-secret',
    PLATFORM_JWT_SECRET: 'test-platform-jwt-secret',
    APP_DATABASE_URL: APP_URL,
    API_PORT: String(API_PORT),
  };
}

// Spawn dist/main.js with a deliberately broken env. Expect non-zero exit
// (failure before listen), with stderr containing every `expect` substring and
// none of the `forbidden` leak tokens. Kills the process if it stays alive.
function runApiExpectFailure(name, envOverrides, expect, forbidden) {
  return new Promise((res) => {
    const child = spawn('node', [API_MAIN], {
      cwd: ROOT,
      env: { ...baseEnv(), ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));

    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15000);

    child.on('exit', async (code) => {
      clearTimeout(killTimer);
      const listening = await isPortListening(API_PORT);
      const exitedNonZero = code !== 0 && code !== null;
      const hasExpected = expect.every((s) => out.includes(s));
      const leaked = forbidden.filter((s) => s && out.includes(s));
      const ok = exitedNonZero && !listening && hasExpected && leaked.length === 0;
      const detail = ok
        ? `exit=${code}`
        : `exit=${code} listening=${listening} expected=${hasExpected} leaked=[${leaked.join(',')}]`;
      record(name, ok, detail);
      res();
    });
  });
}

async function startupChecks() {
  // Leak tokens: passwords and connection-string scheme must never appear.
  const forbidden = ['kirindesk_app_dev_password', 'kirindesk_dev_password', 'postgresql://'];

  // I1: empty TENANT_JWT_SECRET -> requireEnv rejects -> fail before listen.
  await runApiExpectFailure(
    'startup: empty TENANT_JWT_SECRET fails before listen',
    { TENANT_JWT_SECRET: '' },
    ['TENANT_JWT_SECRET'],
    forbidden,
  );

  // I2: empty PLATFORM_JWT_SECRET.
  await runApiExpectFailure(
    'startup: empty PLATFORM_JWT_SECRET fails before listen',
    { PLATFORM_JWT_SECRET: '' },
    ['PLATFORM_JWT_SECRET'],
    forbidden,
  );

  // I3: APP_DATABASE_URL pointing at the superuser role -> role self-check fails.
  await runApiExpectFailure(
    'startup: superuser APP_DATABASE_URL fails before listen',
    { APP_DATABASE_URL: ADMIN_URL },
    ['must not be a superuser'],
    forbidden,
  );
}

// ---------------------------------------------------------------------------
// C. Database permission / RLS checks (reuses the kirindesk_test built by
//    `pnpm test:integration`; this script never creates/migrates/seeds it).
// ---------------------------------------------------------------------------

// Open an app-role client, hard-assert it is on kirindesk_test, hand it to fn.
async function withAppClient(fn) {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    if (rows[0]?.db !== TEST_DB) {
      throw new Error(`Refusing to run: connected to "${rows[0]?.db}", expected "${TEST_DB}"`);
    }
    return await fn(client);
  } finally {
    await client.end();
  }
}

function isPermissionDenied(err) {
  return err?.code === '42501' || /permission denied/i.test(err?.message ?? '');
}

// Verify the test DB is present, migrated and seeded; otherwise tell the user
// to run the integration suite first. Returns true if ready.
async function dbPrecondition() {
  try {
    return await withAppClient(async (client) => {
      const reg = await client.query(
        `SELECT to_regclass('public.audit_logs') AS audit, to_regclass('public.users') AS users`,
      );
      if (!reg.rows[0].audit || !reg.rows[0].users) {
        record('db: kirindesk_test is migrated', false, 'missing tables — run `pnpm test:integration` first');
        return false;
      }
      // Fixture users are tenant-scoped, so look from the correct context.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TEST_TENANT_ID]);
      const cnt = await client.query(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [TEST_USER_ID]);
      const seeded = cnt.rows[0].n === 1;
      record('db: kirindesk_test migrated and seeded', seeded, seeded ? '' : 'fixture user missing — run `pnpm test:integration` first');
      return seeded;
    });
  } catch (err) {
    record('db: kirindesk_test reachable', false, `${err.code ?? err.message} — run \`pnpm test:integration\` first`);
    return false;
  }
}

async function dbChecks() {
  // I7: app role cannot UPDATE audit_logs (REVOKEd in migration 023).
  await withAppClient(async (client) => {
    try {
      await client.query(`UPDATE audit_logs SET reason = 'x'`);
      record('db: UPDATE audit_logs is denied for app role', false, 'UPDATE unexpectedly succeeded');
    } catch (err) {
      record('db: UPDATE audit_logs is denied for app role', isPermissionDenied(err), err.code);
    }
  });

  // I7b: app role cannot DELETE audit_logs.
  await withAppClient(async (client) => {
    try {
      await client.query(`DELETE FROM audit_logs`);
      record('db: DELETE audit_logs is denied for app role', false, 'DELETE unexpectedly succeeded');
    } catch (err) {
      record('db: DELETE audit_logs is denied for app role', isPermissionDenied(err), err.code);
    }
  });

  // I13a: no tenant context -> app_current_tenant_id() is NULL -> RLS hides all.
  await withAppClient(async (client) => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM users`);
    record('db: SELECT users with no tenant context returns 0 rows', rows[0].n === 0, `n=${rows[0].n}`);
  });

  // I13b: wrong tenant context -> still 0 rows (fixture user belongs elsewhere).
  await withAppClient(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [WRONG_TENANT_ID]);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM users`);
    record('db: SELECT users with wrong tenant context returns 0 rows', rows[0].n === 0, `n=${rows[0].n}`);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('== A. static checks ==');
  staticChecks();

  console.log('\n== B. startup failure checks ==');
  if (!existsSync(API_MAIN)) {
    record('startup: dist/main.js exists', false, 'missing — run `pnpm build` first');
  } else if (await isPortListening(API_PORT)) {
    record('startup: port 3001 is free', false, 'something is already listening on 3001');
  } else {
    await startupChecks();
  }

  console.log('\n== C. db / rls checks ==');
  if (await dbPrecondition()) {
    await dbChecks();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('security-regression crashed:', err.message);
  process.exit(1);
});

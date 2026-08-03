import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { assertReleaseRuntimeUrls } from '../packages/database/dist/release-rehearsal-guards.js';

const ROOT = resolve(import.meta.dirname, '..');
const apiRequire = createRequire(resolve(ROOT, 'apps/api/package.json'));
const { Client } = apiRequire('pg');
const API_MAIN = resolve(ROOT, 'apps/api/dist/main.js');
const API_PORT = Number(process.env.RELEASE_TEST_API_PORT ?? 39113);
const BASE_URL = `http://127.0.0.1:${API_PORT}`;
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kirindesk:kirindesk_dev_password@127.0.0.1:5432/kirindesk_test';
const TEST_APP_DATABASE_URL =
  process.env.TEST_APP_DATABASE_URL ??
  'postgresql://kirindesk_app:kirindesk_app_dev_password@127.0.0.1:5432/kirindesk_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1';
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
assertReleaseRuntimeUrls(TEST_DATABASE_URL, TEST_APP_DATABASE_URL, REDIS_URL);
const s3EndpointUrl = new URL(S3_ENDPOINT);
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(s3EndpointUrl.hostname)) {
  throw new Error(
    `Refusing release runtime rehearsal against non-loopback S3 host ${s3EndpointUrl.hostname}.`,
  );
}

function runtimeEnvironment(mode) {
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    API_PORT: String(API_PORT),
    APP_DATABASE_URL: TEST_APP_DATABASE_URL,
    REDIS_URL,
    TENANT_JWT_SECRET: 'release-rehearsal-tenant-secret',
    PLATFORM_JWT_SECRET: 'release-rehearsal-platform-secret',
    S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION ?? 'us-east-1',
    S3_BUCKET: process.env.S3_BUCKET ?? 'kirindesk-files-test',
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'release-rehearsal-access',
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'release-rehearsal-secret',
    // Authentication rate limiting has its own integration coverage. This
    // rehearsal reuses Redis DB 1 after E2E, so fixture logins need headroom.
    LOGIN_RATE_LIMIT_MAX: process.env.RELEASE_LOGIN_RATE_LIMIT_MAX ?? '10000',
    LOGIN_RATE_LIMIT_WINDOW_SEC: '900',
    WORKFLOW_RELEASE_MODE: mode,
  };
  delete environment.DATABASE_URL;
  return environment;
}

async function waitForReady(child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`API exited before readiness.\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/readyz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`API readiness timed out.\n${output.join('')}`);
}

async function withApi(mode, callback) {
  const output = [];
  const child = spawn(process.execPath, [API_MAIN], {
    cwd: ROOT,
    env: runtimeEnvironment(mode),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  try {
    await waitForReady(child, output);
    return await callback();
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

async function login() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'test-user@test.local',
      password: 'test-password-123',
      tenantSlug: 'test-tenant',
    }),
  });
  if (!response.ok)
    throw new Error(`Login failed with ${response.status}: ${await response.text()}`);
  return (await response.json()).accessToken;
}

async function request(path, token, init = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

async function inquiryCount() {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query('SELECT COUNT(*)::int AS count FROM inquiries');
    return result.rows[0].count;
  } finally {
    await client.end();
  }
}

function p95(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function benchmark() {
  const token = await login();
  const inquiriesResponse = await request('/api/inquiries?pageSize=1', token);
  if (!inquiriesResponse.ok) {
    throw new Error(
      `Performance fixture lookup failed with ${inquiriesResponse.status}: ${await inquiriesResponse.text()}`,
    );
  }
  const inquiries = await inquiriesResponse.json();
  const inquiryId = Array.isArray(inquiries) ? inquiries[0]?.id : undefined;
  if (!inquiryId) throw new Error('Performance rehearsal requires at least one persisted inquiry.');
  const probes = [
    { name: 'workbench', path: '/api/workbench' },
    { name: 'inquiry-list', path: '/api/inquiries?pageSize=20' },
    {
      name: 'credential-chain',
      path: `/api/business-events?chainType=inquiry&chainId=${encodeURIComponent(inquiryId)}&pageSize=30`,
    },
  ];
  const durations = new Map(probes.map((probe) => [probe.name, []]));
  const batches = 15;
  const concurrency = 8;
  for (let batch = 0; batch < batches; batch += 1) {
    const results = await Promise.all(
      Array.from({ length: concurrency }, async (_, index) => {
        const probe = probes[(batch * concurrency + index) % probes.length];
        const startedAt = performance.now();
        const response = await request(probe.path, token);
        await response.arrayBuffer();
        return {
          name: probe.name,
          duration: performance.now() - startedAt,
          status: response.status,
        };
      }),
    );
    for (const result of results) {
      if (result.status !== 200) {
        throw new Error(`Performance probe ${result.name} returned ${result.status}.`);
      }
      durations.get(result.name).push(result.duration);
    }
  }
  const threshold = Number(process.env.RELEASE_PERFORMANCE_P95_MS ?? 500);
  const routeResults = probes.map((probe) => {
    const routeDurations = durations.get(probe.name);
    const routeP95 = p95(routeDurations);
    if (routeP95 > threshold) {
      throw new Error(
        `Performance probe ${probe.name} p95 ${routeP95.toFixed(2)}ms exceeds ${threshold}ms.`,
      );
    }
    return {
      name: probe.name,
      requests: routeDurations.length,
      p95Ms: Number(routeP95.toFixed(2)),
    };
  });
  const metrics = await fetch(`${BASE_URL}/metrics`).then((response) => response.text());
  for (const metric of [
    'kirindesk_http_requests_total',
    'kirindesk_http_request_duration_seconds_bucket',
  ]) {
    if (!metrics.includes(metric)) throw new Error(`Prometheus metric ${metric} was not emitted.`);
  }
  const allDurations = [...durations.values()].flat();
  return {
    requests: allDurations.length,
    overallP95Ms: Number(p95(allDurations).toFixed(2)),
    thresholdMs: threshold,
    routes: routeResults,
  };
}

async function rehearseReadOnly() {
  const token = await login();
  const before = await inquiryCount();
  const readable = await request('/api/inquiries?pageSize=1', token);
  if (readable.status !== 200) throw new Error(`Read-only GET returned ${readable.status}.`);
  const rejected = await request('/api/inquiries', token, {
    method: 'POST',
    body: JSON.stringify({ customer_code: 'RELEASE-REHEARSAL' }),
  });
  if (rejected.status !== 423) throw new Error(`Read-only POST returned ${rejected.status}.`);
  const after = await inquiryCount();
  if (before !== after)
    throw new Error(`Read-only rehearsal changed inquiry count ${before} -> ${after}.`);
  return { readStatus: readable.status, writeStatus: rejected.status, preservedRows: after };
}

async function rehearseHidden() {
  const token = await login();
  const meResponse = await request('/api/auth/me', token);
  const me = await meResponse.json();
  if (me.workflowMode !== 'hidden')
    throw new Error('Hidden mode was not exposed to the web client.');
  const hidden = await request('/api/inquiries?pageSize=1', token);
  if (hidden.status !== 404) throw new Error(`Hidden workflow GET returned ${hidden.status}.`);
  const core = await request('/api/customers?pageSize=1', token);
  if (core.status !== 200) throw new Error(`Core customer GET returned ${core.status}.`);
  return { workflowStatus: hidden.status, coreStatus: core.status };
}

const performanceResult = await withApi('active', benchmark);
const readOnlyResult = await withApi('read_only', rehearseReadOnly);
const hiddenResult = await withApi('hidden', rehearseHidden);

console.log(
  JSON.stringify(
    {
      status: 'PASS',
      performance: performanceResult,
      applicationRollback: {
        readOnly: readOnlyResult,
        hidden: hiddenResult,
      },
    },
    null,
    2,
  ),
);

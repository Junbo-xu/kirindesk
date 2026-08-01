const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const RELEASE_TEST_DATABASE = 'kirindesk_test';

export function assertLoopbackPostgresUrl(connectionString: string): URL {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Release rehearsal requires a PostgreSQL connection URL.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing release rehearsal against non-loopback PostgreSQL host ${parsed.hostname}.`,
    );
  }
  return parsed;
}

function assertReleaseTestPostgresUrl(label: string, connectionString: string): URL {
  const parsed = assertLoopbackPostgresUrl(connectionString);
  const database = parsed.pathname.slice(1);
  if (database !== RELEASE_TEST_DATABASE) {
    throw new Error(
      `Refusing release runtime rehearsal on ${label} database "${database}"; expected "${RELEASE_TEST_DATABASE}".`,
    );
  }
  return parsed;
}

export function assertReleaseRuntimeUrls(
  adminConnectionString: string,
  appConnectionString: string,
  redisConnectionString: string,
): void {
  const admin = assertReleaseTestPostgresUrl('admin', adminConnectionString);
  const app = assertReleaseTestPostgresUrl('application', appConnectionString);
  if (admin.hostname !== app.hostname || admin.port !== app.port) {
    throw new Error(
      'Release runtime admin and application databases must use the same local instance.',
    );
  }

  const redis = new URL(redisConnectionString);
  if (redis.protocol !== 'redis:') {
    throw new Error('Release runtime rehearsal requires a Redis connection URL.');
  }
  const redisHostname = redis.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(redisHostname)) {
    throw new Error(
      `Refusing release runtime rehearsal against non-loopback Redis host ${redis.hostname}.`,
    );
  }
  if (redis.pathname !== '/1') {
    throw new Error('Release runtime rehearsal requires isolated Redis database 1.');
  }
}

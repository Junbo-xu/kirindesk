import { describe, expect, it } from 'vitest';
import { assertLoopbackPostgresUrl, assertReleaseRuntimeUrls } from './release-rehearsal-guards.js';

describe('assertLoopbackPostgresUrl', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts loopback host %s', (host) => {
    expect(
      assertLoopbackPostgresUrl(`postgresql://user:password@${host}:5432/kirindesk_test`).hostname,
    ).toBe(host);
  });

  it('refuses remote PostgreSQL hosts', () => {
    expect(() =>
      assertLoopbackPostgresUrl('postgresql://user:password@db.internal:5432/kirindesk_test'),
    ).toThrow('Refusing release rehearsal against non-loopback PostgreSQL host db.internal.');
  });

  it('refuses non-PostgreSQL protocols', () => {
    expect(() => assertLoopbackPostgresUrl('https://127.0.0.1/kirindesk_test')).toThrow(
      'Release rehearsal requires a PostgreSQL connection URL.',
    );
  });
});

describe('assertReleaseRuntimeUrls', () => {
  const adminUrl = 'postgresql://admin:password@127.0.0.1:5432/kirindesk_test';
  const appUrl = 'postgresql://app:password@127.0.0.1:5432/kirindesk_test';

  it('accepts the isolated local PostgreSQL and Redis test instances', () => {
    expect(() =>
      assertReleaseRuntimeUrls(adminUrl, appUrl, 'redis://localhost:6379/1'),
    ).not.toThrow();
  });

  it('refuses a non-test application database', () => {
    expect(() =>
      assertReleaseRuntimeUrls(
        adminUrl,
        'postgresql://app:password@127.0.0.1:5432/kirindesk',
        'redis://127.0.0.1:6379/1',
      ),
    ).toThrow('expected "kirindesk_test"');
  });

  it('refuses an application database on another local PostgreSQL instance', () => {
    expect(() =>
      assertReleaseRuntimeUrls(
        adminUrl,
        'postgresql://app:password@localhost:55432/kirindesk_test',
        'redis://127.0.0.1:6379/1',
      ),
    ).toThrow('must use the same local instance');
  });

  it('refuses a remote application database', () => {
    expect(() =>
      assertReleaseRuntimeUrls(
        adminUrl,
        'postgresql://app:password@db.internal:5432/kirindesk_test',
        'redis://127.0.0.1:6379/1',
      ),
    ).toThrow('Refusing release rehearsal against non-loopback PostgreSQL host db.internal.');
  });

  it('refuses a remote Redis host', () => {
    expect(() =>
      assertReleaseRuntimeUrls(adminUrl, appUrl, 'redis://cache.internal:6379/1'),
    ).toThrow('Refusing release runtime rehearsal against non-loopback Redis host cache.internal.');
  });

  it('refuses the shared default Redis database', () => {
    expect(() => assertReleaseRuntimeUrls(adminUrl, appUrl, 'redis://127.0.0.1:6379/0')).toThrow(
      'Release runtime rehearsal requires isolated Redis database 1.',
    );
  });
});

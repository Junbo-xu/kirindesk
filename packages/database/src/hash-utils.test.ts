import { describe, expect, it } from 'vitest';
import { canonicalizeJson, computeRowHash, type AuditLogHashInput } from './hash-utils.js';

describe('canonicalizeJson', () => {
  it('sorts object keys deterministically regardless of input order', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }));
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('handles nested objects and arrays stably', () => {
    const a = canonicalizeJson({ outer: { y: 1, x: 2 }, list: [3, { n: 1, m: 2 }] });
    const b = canonicalizeJson({ list: [3, { m: 2, n: 1 }], outer: { x: 2, y: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"list":[3,{"m":2,"n":1}],"outer":{"x":2,"y":1}}');
  });

  it('returns empty string for null and undefined', () => {
    expect(canonicalizeJson(null)).toBe('');
    expect(canonicalizeJson(undefined)).toBe('');
  });

  it('JSON-encodes primitive values', () => {
    expect(canonicalizeJson(42)).toBe('42');
    expect(canonicalizeJson('x')).toBe('"x"');
  });
});

function baseRow(): AuditLogHashInput {
  return {
    hash_version: 1,
    prev_hash: '0'.repeat(64),
    tenant_id: 't1',
    actor_type: 'tenant_user',
    actor_id: 'u1',
    action: 'auth:login_success',
    resource_type: 'user',
    resource_id: 'u1',
    before_json: null,
    after_json: { a: 1, b: 2 },
    metadata_json: null,
    request_id: null,
    ip_address: '127.0.0.1',
    user_agent: 'test',
    reason: null,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
  };
}

describe('computeRowHash', () => {
  it('is deterministic for the same input', () => {
    expect(computeRowHash(baseRow())).toBe(computeRowHash(baseRow()));
  });

  it('produces a 64-character hex sha256 digest', () => {
    expect(computeRowHash(baseRow())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a material field changes', () => {
    const changed = { ...baseRow(), action: 'auth:login_failure' };
    expect(computeRowHash(changed)).not.toBe(computeRowHash(baseRow()));
  });

  it('is stable when JSON field key order changes', () => {
    const reordered = { ...baseRow(), after_json: { b: 2, a: 1 } };
    expect(computeRowHash(reordered)).toBe(computeRowHash(baseRow()));
  });
});


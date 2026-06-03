import { describe, expect, it } from 'vitest';
import { CustomerRow, toCustomerResponse } from './customers.response';

// A full row including the internal columns that must never reach a response.
function makeRow(overrides: Partial<CustomerRow> = {}): CustomerRow {
  const now = new Date();
  return {
    id: 'c1',
    tenant_id: 'tenant-secret',
    owner_user_id: 'owner-1',
    company_name: 'Acme',
    contact_name: 'Jane',
    email: 'jane@acme.test',
    phone: '123',
    country: 'US',
    source: 'web',
    status: 'active',
    notes: 'internal note',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

describe('toCustomerResponse (allowlist)', () => {
  it('omits tenant_id, deleted_at, and notes', () => {
    const res = toCustomerResponse(makeRow()) as unknown as Record<string, unknown>;
    expect('tenant_id' in res).toBe(false);
    expect('deleted_at' in res).toBe(false);
    expect('notes' in res).toBe(false);
  });

  it('omits internal fields even when deleted_at is set', () => {
    const res = toCustomerResponse(makeRow({ deleted_at: new Date() })) as unknown as Record<
      string,
      unknown
    >;
    expect('deleted_at' in res).toBe(false);
    expect('tenant_id' in res).toBe(false);
  });

  it('exposes exactly the public fields', () => {
    const res = toCustomerResponse(makeRow());
    expect(Object.keys(res).sort()).toEqual(
      [
        'company_name',
        'contact_name',
        'country',
        'created_at',
        'email',
        'id',
        'owner_user_id',
        'phone',
        'source',
        'status',
        'updated_at',
      ].sort(),
    );
  });

  it('passes through public values unchanged', () => {
    const res = toCustomerResponse(makeRow({ company_name: 'Globex', status: 'inactive' }));
    expect(res.company_name).toBe('Globex');
    expect(res.status).toBe('inactive');
    expect(res.owner_user_id).toBe('owner-1');
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations');

describe('published migration checksums', () => {
  it('keeps the staging-applied 051 migration immutable', () => {
    const migration = readFileSync(
      join(migrationsDirectory, '051_kir_21_p0_web_remediation.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      '4e697e314712a1796550ef7cf8a6852a75ef1d7296cf489b0ab9f0d5b4fd0992',
    );
  });

  it('keeps the main-applied KIR-33 stage A 054 migration immutable', () => {
    const migration = readFileSync(
      join(migrationsDirectory, '054_kir_33_stage_a_quote_order_link.sql'),
      'utf8',
    );
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      '7e8690c1c017d14a56839cd51bc20541f21b040a7a8272eb020d43492760f347',
    );
  });
});

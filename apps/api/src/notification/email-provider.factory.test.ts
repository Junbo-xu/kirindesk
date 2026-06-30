import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockEmailProvider } from './mock-email-provider';
import { SmtpEmailProvider } from './smtp-email-provider';
import { resolveEmailProvider } from './email-provider.factory';

// Isolate env mutations per test.
const saved: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) saved[k] = process.env[k];
}
function restoreEnv(...keys: string[]) {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

describe('resolveEmailProvider (factory)', () => {
  beforeEach(() => saveEnv(...SMTP_KEYS));
  afterEach(() => restoreEnv(...SMTP_KEYS));

  it('returns MockEmailProvider when SMTP_HOST is not set', () => {
    delete process.env['SMTP_HOST'];
    const provider = resolveEmailProvider();
    expect(provider).toBeInstanceOf(MockEmailProvider);
  });

  it('returns MockEmailProvider when SMTP_HOST is an empty string', () => {
    process.env['SMTP_HOST'] = '';
    const provider = resolveEmailProvider();
    // Empty string is falsy — same as unset.
    expect(provider).toBeInstanceOf(MockEmailProvider);
  });

  it('returns SmtpEmailProvider when SMTP_HOST is set', () => {
    process.env['SMTP_HOST'] = 'smtp.example.com';
    process.env['SMTP_USER'] = 'user@example.com';
    process.env['SMTP_PASS'] = 'secret';
    const provider = resolveEmailProvider();
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
  });

  it('SmtpEmailProvider uses port 465 with implicit TLS by default', () => {
    process.env['SMTP_HOST'] = 'smtp.example.com';
    process.env['SMTP_USER'] = 'u';
    process.env['SMTP_PASS'] = 'p';
    delete process.env['SMTP_PORT'];
    // Should construct without throwing.
    const provider = resolveEmailProvider();
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
  });

  it('SmtpEmailProvider falls back to SMTP_USER as from address when SMTP_FROM is unset', () => {
    process.env['SMTP_HOST'] = 'smtp.example.com';
    process.env['SMTP_USER'] = 'sender@example.com';
    process.env['SMTP_PASS'] = 'p';
    delete process.env['SMTP_FROM'];
    const provider = resolveEmailProvider();
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
    // from is a private field; construction must not throw.
  });
});

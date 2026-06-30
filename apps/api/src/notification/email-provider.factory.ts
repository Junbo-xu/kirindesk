import { Logger } from '@nestjs/common';
import type { EmailProvider } from './email-provider.interface';
import { MockEmailProvider } from './mock-email-provider';
import { SmtpEmailProvider } from './smtp-email-provider';

const logger = new Logger('EmailProviderFactory');

/**
 * Resolves the active EmailProvider at startup.
 *
 * Selection logic (Phase 1N real-send addition):
 *   - SMTP_HOST set   → SmtpEmailProvider (nodemailer, real send)
 *   - SMTP_HOST unset → MockEmailProvider (dev/test, no network)
 *
 * This keeps mock as the zero-config default so dev/CI require no SMTP env.
 */
export function resolveEmailProvider(): EmailProvider {
  if (process.env['SMTP_HOST']) {
    logger.log(
      `Email provider: smtp (${process.env['SMTP_HOST']}:${process.env['SMTP_PORT'] ?? '465'})`,
    );
    return new SmtpEmailProvider();
  }
  logger.log('Email provider: mock (SMTP_HOST not set — using mock)');
  return new MockEmailProvider();
}

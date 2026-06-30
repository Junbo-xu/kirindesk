import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { EmailMessage, EmailProvider } from './email-provider.interface';

/**
 * SMTP email provider backed by nodemailer (Phase 1N real-send path).
 * Activated when SMTP_HOST is set in the environment; the notification module
 * falls back to MockEmailProvider when SMTP_HOST is absent.
 *
 * Required env vars: SMTP_HOST, SMTP_USER, SMTP_PASS
 * Optional env vars: SMTP_PORT (default 465), SMTP_FROM (default SMTP_USER)
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor() {
    const port = parseInt(process.env['SMTP_PORT'] ?? '465', 10);
    // Port 465 uses implicit TLS (secure: true); all other ports use STARTTLS.
    const secure = port === 465;

    this.from = process.env['SMTP_FROM'] ?? process.env['SMTP_USER'] ?? 'noreply@example.com';

    this.transporter = nodemailer.createTransport({
      host: process.env['SMTP_HOST'],
      port,
      secure,
      auth: {
        user: process.env['SMTP_USER'],
        pass: process.env['SMTP_PASS'],
      },
    });

    this.logger.log(
      `SMTP provider configured: host=${process.env['SMTP_HOST']} port=${port} from=${this.from}`,
    );
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

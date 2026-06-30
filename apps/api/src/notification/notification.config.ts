// Email provider selection is auto-detected from SMTP_HOST (see
// email-provider.factory.ts). This module validates the legacy
// NOTIFICATION_PROVIDER env var when explicitly set, and accepts 'smtp' as
// a valid value for documentation/override purposes.

export const NOTIFICATION_PROVIDER_KEY = process.env['NOTIFICATION_PROVIDER'] ?? 'auto';

if (!['mock', 'smtp', 'auto'].includes(NOTIFICATION_PROVIDER_KEY)) {
  throw new Error(
    `Unknown NOTIFICATION_PROVIDER="${NOTIFICATION_PROVIDER_KEY}". Accepted: mock | smtp | auto`,
  );
}

export const NOTIFICATION_PROVIDER_KEY = process.env['NOTIFICATION_PROVIDER'] ?? 'mock';

if (!['mock'].includes(NOTIFICATION_PROVIDER_KEY)) {
  throw new Error(`Unknown NOTIFICATION_PROVIDER="${NOTIFICATION_PROVIDER_KEY}". Accepted: mock`);
}

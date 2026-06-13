// Upload guardrails. Enforced server-side; the client Content-Type is not
// trusted as the sole signal (size is checked by multer, MIME against this
// allowlist).
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  // Office documents
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// Lifetime of a signed download token.
export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

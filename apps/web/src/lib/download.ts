/**
 * Triggers a browser "save as" for an in-memory blob (plan §6.2). The object
 * URL is transient and revoked immediately after the click — nothing is written
 * to localStorage / sessionStorage / the URL bar, so export content never
 * escapes this call (privacy, plan §6.5).
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

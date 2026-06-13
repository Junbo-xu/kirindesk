export interface FileRow {
  id: string;
  tenant_id: string;
  uploaded_by: string;
  original_name: string;
  storage_key: string;
  mime_type: string;
  size_bytes: string; // pg bigint -> string
  sha256: string;
  purpose: string | null;
  metadata_json: unknown;
  created_at: Date;
  deleted_at: Date | null;
}

export interface FileResponse {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  purpose: string | null;
  uploaded_by: string;
  created_at: Date;
}

/**
 * Maps a DB row to the public response shape. Explicit allowlist: storage_key,
 * tenant_id, metadata_json and deleted_at are never exposed. storage_key in
 * particular must stay server-side so object locations are not disclosed.
 */
export function toFileResponse(row: FileRow): FileResponse {
  return {
    id: row.id,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    purpose: row.purpose,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
}

import { CSSProperties, FormEvent, useEffect, useRef, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, FileResponse } from '../lib/types';

const PAGE_SIZE = 20;

// Mirrors the server-side allowlist (files.constants.ts). Used for the file
// input's accept hint; the server is the source of truth and re-validates.
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx';
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function formatSize(bytes: string): string {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return bytes;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesListPage() {
  const [files, setFiles] = useState<FileResponse[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [purpose, setPurpose] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .listFiles({ page, pageSize: PAGE_SIZE, q: appliedQ || undefined })
      .then((res) => {
        if (!active) return;
        setFiles(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : '加载文件失败，请稍后重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, appliedQ]);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setAppliedQ(q.trim());
  }

  async function reload() {
    setLoading(true);
    try {
      const res = await apiClient.listFiles({ page, pageSize: PAGE_SIZE, q: appliedQ || undefined });
      setFiles(res.data);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载文件失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const input = fileInputRef.current;
    const file = input?.files?.[0];
    if (!file) {
      setError('请选择要上传的文件');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('文件超过 25MB 上限');
      return;
    }
    setUploading(true);
    try {
      await apiClient.uploadFile(file, purpose.trim() || undefined);
      if (input) input.value = '';
      setPurpose('');
      setPage(1);
      setAppliedQ('');
      await reload();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 400) setError(err instanceof ApiError ? err.message : '文件类型不被支持');
      else if (status === 413) setError('文件超过大小上限');
      else if (status === 403) setError('没有权限上传文件');
      else setError(err instanceof ApiError ? err.message : '上传失败，请稍后重试');
    } finally {
      setUploading(false);
    }
  }

  async function onDownload(file: FileResponse) {
    setError(null);
    try {
      const url = await apiClient.getFileDownloadUrl(file.id);
      // Navigate to the one-time token URL; the browser handles the download.
      window.location.href = url;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) setError('文件不存在或已被删除');
      else if (status === 403) setError('没有权限下载该文件');
      else setError(err instanceof ApiError ? err.message : '下载失败，请稍后重试');
    }
  }

  async function onDelete(file: FileResponse) {
    if (!window.confirm(`确认删除文件 ${file.original_name}？此操作不可撤销。`)) return;
    setError(null);
    try {
      await apiClient.deleteFile(file.id);
      if (files.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await reload();
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) setError('文件不存在或已被删除');
      else if (status === 409) setError('该文件已被单据引用，无法删除');
      else if (status === 403) setError('没有权限执行该操作');
      else setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ddd' };
  const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eee' };

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>文件</h1>

      <form
        onSubmit={onUpload}
        style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <input ref={fileInputRef} type="file" accept={ACCEPT} />
        <input
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="用途（可选，如 pi）"
        />
        <button type="submit" disabled={uploading}>
          {uploading ? '上传中…' : '上传'}
        </button>
      </form>

      <form onSubmit={applyFilters} style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件名" />
        <button type="submit">筛选</button>
      </form>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : files.length === 0 ? (
        <p>暂无文件</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>文件名</th>
              <th style={th}>类型</th>
              <th style={th}>大小</th>
              <th style={th}>用途</th>
              <th style={th}>上传时间</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td style={td}>{f.original_name}</td>
                <td style={td}>{f.mime_type}</td>
                <td style={td}>{formatSize(f.size_bytes)}</td>
                <td style={td}>{f.purpose ?? '-'}</td>
                <td style={td}>{new Date(f.created_at).toLocaleString()}</td>
                <td style={td}>
                  <button onClick={() => onDownload(f)}>下载</button>{' '}
                  <button onClick={() => onDelete(f)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
        <button onClick={() => setPage(page - 1)} disabled={page <= 1}>上一页</button>
        <span>第 {page} / {totalPages} 页</span>
        <button onClick={() => setPage(page + 1)} disabled={page >= totalPages}>下一页</button>
      </div>
    </div>
  );
}

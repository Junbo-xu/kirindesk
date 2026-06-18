import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, InvocationSummary, OcrExtractResponse } from '../lib/types';

const PAGE_SIZE = 20;

// Maps an ApiError to user-facing copy. The live OCR text / fields are only
// ever shown from the extract response held in component state — never
// persisted, logged, or re-fetched (plan §5.1).
function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 403) return '没有权限发起 OCR';
  if (err.status === 404) return '文件不存在或不在你的可见范围内';
  if (err.status === 400) return err.message || '请求参数有误';
  if (err.status === 500) return '识别失败，请稍后重试';
  return err.message || fallback;
}

export function OcrPage() {
  // --- extract form ---
  const [fileId, setFileId] = useState('');
  const [docType, setDocType] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OcrExtractResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // --- invocation list ---
  const [rows, setRows] = useState<InvocationSummary[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Set when the server denies the read (no ocr:view). The list region is
  // replaced by a notice, matching the app's graceful-403 handling.
  const [forbidden, setForbidden] = useState(false);

  // --- detail (page-local, no separate route) ---
  const [selected, setSelected] = useState<InvocationSummary | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setListLoading(true);
    setListError(null);
    apiClient
      .listOcr({ page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (!active) return;
        setRows(res.data);
        setTotal(res.total);
        setForbidden(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          setRows([]);
          setTotal(0);
          return;
        }
        setListError(describeError(err, '加载调用记录失败，请稍后重试'));
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page]);

  async function reloadList() {
    try {
      const res = await apiClient.listOcr({ page, pageSize: PAGE_SIZE });
      setRows(res.data);
      setTotal(res.total);
    } catch {
      // A list refresh failure should not clobber a successful extract result;
      // the next paginated load surfaces any persistent error.
    }
  }

  async function onExtract(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const id = fileId.trim();
    if (!id) {
      setFormError('请填写文件 ID');
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await apiClient.ocrExtract({
        fileId: id,
        docType: docType.trim() || undefined,
      });
      setResult(res);
      // Bring the new record into view: go to page 1 and refresh.
      if (page !== 1) setPage(1);
      else await reloadList();
    } catch (err) {
      setFormError(describeError(err, '识别失败，请稍后重试'));
    } finally {
      setRunning(false);
    }
  }

  async function onSelect(row: InvocationSummary) {
    setListError(null);
    try {
      // Re-fetch the single record so detail reflects the server's view; it is
      // a summary only (no full text — never persisted).
      const fresh = await apiClient.getOcr(row.id);
      setSelected(fresh);
    } catch (err) {
      setListError(describeError(err, '加载详情失败，请稍后重试'));
    }
  }

  const th: CSSProperties = {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid #ddd',
  };
  const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eee' };

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>OCR 识别</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        对一个已在可见范围内的文件发起 OCR（当前为 mock provider，返回确定性结果）。
        识别全文不会被保存，仅展示在本次结果中。
      </p>

      <form
        onSubmit={onExtract}
        style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <input
          value={fileId}
          onChange={(e) => setFileId(e.target.value)}
          placeholder="文件 ID（UUID）"
          style={{ width: 320 }}
        />
        <select value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="">文档类型（可选）</option>
          <option value="invoice">发票 invoice</option>
          <option value="order">订单 order</option>
        </select>
        <button type="submit" disabled={running}>
          {running ? '识别中…' : '发起 OCR'}
        </button>
      </form>

      {formError && <p style={{ color: 'crimson' }}>{formError}</p>}

      {result && (
        <div style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, margin: '12px 0' }}>
          <strong>识别结果</strong>
          <div style={{ fontSize: 13, color: '#555', margin: '6px 0' }}>
            provider: {result.invocation.providerName} · 状态: {result.invocation.status} · 置信度:{' '}
            {result.confidence} · 耗时: {result.invocation.durationMs ?? '-'} ms
          </div>
          {result.fields.length > 0 && (
            <table style={{ borderCollapse: 'collapse', margin: '8px 0' }}>
              <thead>
                <tr>
                  <th style={th}>字段</th>
                  <th style={th}>值</th>
                  <th style={th}>置信度</th>
                </tr>
              </thead>
              <tbody>
                {result.fields.map((f) => (
                  <tr key={f.key}>
                    <td style={td}>{f.key}</td>
                    <td style={td}>{f.value}</td>
                    <td style={td}>{f.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary style={{ cursor: 'pointer' }}>识别文本（不保存）</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f7f7f7', padding: 8 }}>
              {result.text}
            </pre>
          </details>
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>调用记录</h2>
      {listError && <p style={{ color: 'crimson' }}>{listError}</p>}
      {forbidden ? (
        <p style={{ color: '#a60' }}>没有权限查看 OCR 调用记录。</p>
      ) : listLoading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p>暂无调用记录</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>时间</th>
              <th style={th}>provider</th>
              <th style={th}>动作</th>
              <th style={th}>状态</th>
              <th style={th}>来源文件</th>
              <th style={th}>耗时(ms)</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={td}>{r.providerName}</td>
                <td style={td}>{r.action}</td>
                <td style={td}>{r.status}</td>
                <td style={td}>{r.sourceFileId ?? '-'}</td>
                <td style={td}>{r.durationMs ?? '-'}</td>
                <td style={td}>
                  <button onClick={() => onSelect(r)}>详情</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!forbidden && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
          <button onClick={() => setPage(page - 1)} disabled={page <= 1}>
            上一页
          </button>
          <span>
            第 {page} / {totalPages} 页
          </span>
          <button onClick={() => setPage(page + 1)} disabled={page >= totalPages}>
            下一页
          </button>
        </div>
      )}

      {selected && (
        <div style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>调用详情</strong>
            <button onClick={() => setSelected(null)}>关闭</button>
          </div>
          <dl style={{ fontSize: 13 }}>
            <div>ID：{selected.id}</div>
            <div>provider：{selected.providerName}</div>
            <div>类型：{selected.providerType}</div>
            <div>动作：{selected.action}</div>
            <div>状态：{selected.status}</div>
            <div>来源文件：{selected.sourceFileId ?? '-'}</div>
            <div>耗时：{selected.durationMs ?? '-'} ms</div>
            <div>时间：{new Date(selected.createdAt).toLocaleString()}</div>
          </dl>
          <p style={{ color: '#999', fontSize: 12 }}>识别全文不会被保存，故详情中不含原文。</p>
        </div>
      )}
    </div>
  );
}

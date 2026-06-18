import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, AiCompleteResponse, InvocationSummary } from '../lib/types';

const PAGE_SIZE = 20;

// Maps an ApiError to user-facing copy. The live AI output is only ever shown
// from the completion response held in component state — never persisted,
// logged, or re-fetched (plan §5.1).
function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 403) return '没有权限发起 AI 调用';
  if (err.status === 400) return err.message || '请求参数有误';
  if (err.status === 500) return 'AI 调用失败，请稍后重试';
  return err.message || fallback;
}

export function CompletePage() {
  // --- completion form ---
  const [task, setTask] = useState('');
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiCompleteResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // --- invocation list ---
  const [rows, setRows] = useState<InvocationSummary[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Set when the server denies the read (no ai:view). The list region is
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
      .listAiCompletions({ page, pageSize: PAGE_SIZE })
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
      const res = await apiClient.listAiCompletions({ page, pageSize: PAGE_SIZE });
      setRows(res.data);
      setTotal(res.total);
    } catch {
      // A list refresh failure should not clobber a successful completion result.
    }
  }

  async function onComplete(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const t = task.trim();
    if (!t) {
      setFormError('请填写任务名');
      return;
    }
    if (!input.trim()) {
      setFormError('请填写输入文本');
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await apiClient.aiComplete({ task: t, input });
      setResult(res);
      if (page !== 1) setPage(1);
      else await reloadList();
    } catch (err) {
      setFormError(describeError(err, 'AI 调用失败，请稍后重试'));
    } finally {
      setRunning(false);
    }
  }

  async function onSelect(row: InvocationSummary) {
    setListError(null);
    try {
      // Re-fetch the single record; it is a summary only (no full output —
      // never persisted).
      const fresh = await apiClient.getAiCompletion(row.id);
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
      <h1 style={{ fontSize: 20 }}>AI 补全</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        发起一次 AI 补全调用（当前为 mock provider，返回确定性结果）。输入文本不会被保存，
        仅记录其长度；输出仅展示在本次结果中。
      </p>

      <form onSubmit={onComplete} style={{ margin: '12px 0' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="任务名，如 extract-order-fields"
            style={{ width: 320 }}
          />
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="已最小化的输入文本（请勿粘贴原始客户文件内容）"
          rows={5}
          style={{ width: '100%', margin: '8px 0', fontFamily: 'inherit' }}
        />
        <button type="submit" disabled={running}>
          {running ? '调用中…' : '发起 AI 补全'}
        </button>
      </form>

      {formError && <p style={{ color: 'crimson' }}>{formError}</p>}

      {result && (
        <div style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, margin: '12px 0' }}>
          <strong>调用结果</strong>
          <div style={{ fontSize: 13, color: '#555', margin: '6px 0' }}>
            provider: {result.invocation.providerName} · 状态: {result.invocation.status} · tokens:{' '}
            {result.invocation.tokensUsed ?? '-'} · 耗时: {result.invocation.durationMs ?? '-'} ms
          </div>
          <details open>
            <summary style={{ cursor: 'pointer' }}>输出（不保存）</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: '#f7f7f7', padding: 8 }}>
              {result.output}
            </pre>
          </details>
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>调用记录</h2>
      {listError && <p style={{ color: 'crimson' }}>{listError}</p>}
      {forbidden ? (
        <p style={{ color: '#a60' }}>没有权限查看 AI 调用记录。</p>
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
              <th style={th}>tokens</th>
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
                <td style={td}>{r.tokensUsed ?? '-'}</td>
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
            <div>tokens：{selected.tokensUsed ?? '-'}</div>
            <div>耗时：{selected.durationMs ?? '-'} ms</div>
            <div>时间：{new Date(selected.createdAt).toLocaleString()}</div>
          </dl>
          <p style={{ color: '#999', fontSize: 12 }}>输入与输出均不会被保存，故详情中不含原文。</p>
        </div>
      )}
    </div>
  );
}

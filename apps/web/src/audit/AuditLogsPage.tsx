import { CSSProperties, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { saveBlob } from '../lib/download';
import {
  ApiError,
  AuditActorType,
  AuditChainVerifyResult,
  AuditLogDetail,
  AuditLogSummary,
  ListAuditLogsQuery,
} from '../lib/types';

const PAGE_SIZE = 20;

// Default window: trailing 7 days through today (plan §5.3), so the first
// render constrains the high-write audit table to a useful slice. `to` is
// pushed to end-of-day inclusively by the backend's created_at <= to.
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 7);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

// The date picker yields a bare YYYY-MM-DD, which the backend's
// `created_at <= to` would resolve to that day's 00:00 — excluding everything
// that happened during the day itself (so "to = today" hides today's events).
// Expand a date-only value to an inclusive end-of-day timestamp; pass through
// anything that already carries a time component.
function inclusiveTo(to?: string): string | undefined {
  if (!to) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to;
}

const ACTOR_TYPE_LABELS: Record<string, string> = {
  tenant_user: '租户用户',
  platform_admin: '平台管理员',
  system: '系统',
};

function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 404) return '记录不存在或不在你的可见范围内';
  if (err.status === 400) return err.message || '请求参数有误';
  return err.message || fallback;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Renders any jsonb value into a single cell: strings as-is, everything else
// as compact JSON. Snapshots are shown verbatim — never re-parsed/enriched.
function formatValue(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

type DiffKind = 'added' | 'removed' | 'changed' | 'same';

interface DiffRow {
  key: string;
  before: unknown;
  after: unknown;
  kind: DiffKind;
}

// Field-level diff over the union of keys when both snapshots are plain objects
// (or one is null). Returns null to signal the caller to fall back to a
// side-by-side JSON view for shapes we cannot diff key-by-key (plan §5.4).
function diffSnapshots(before: unknown, after: unknown): DiffRow[] | null {
  const b = before == null ? {} : before;
  const a = after == null ? {} : after;
  if (!isPlainObject(b) || !isPlainObject(a)) return null;
  if (before == null && after == null) return [];

  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  return keys.map((key) => {
    const hasB = key in b;
    const hasA = key in a;
    let kind: DiffKind;
    if (!hasB && hasA) kind = 'added';
    else if (hasB && !hasA) kind = 'removed';
    else kind = JSON.stringify(b[key]) === JSON.stringify(a[key]) ? 'same' : 'changed';
    return { key, before: b[key], after: a[key], kind };
  });
}

const DIFF_LABEL: Record<DiffKind, string> = {
  added: '新增',
  removed: '移除',
  changed: '变更',
  same: '',
};

const DIFF_COLOR: Record<DiffKind, string> = {
  added: '#0a7d23',
  removed: '#b00020',
  changed: '#a60',
  same: '#999',
};

export function AuditLogsPage() {
  const initial = useMemo(defaultRange, []);

  // Draft filter inputs (edited freely) vs. the applied query that drives the
  // fetch — same submit-to-apply convention as the other list pages.
  const [draft, setDraft] = useState<ListAuditLogsQuery>({ ...initial });
  const [applied, setApplied] = useState<ListAuditLogsQuery>({ ...initial });
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<AuditLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Server denied the read (no audit_logs:view) → whole page degrades to a
  // notice, matching the app's graceful-403 convention (plan §5.1).
  const [forbidden, setForbidden] = useState(false);

  const [chain, setChain] = useState<AuditChainVerifyResult | null>(null);
  const [chainError, setChainError] = useState(false);

  const [selected, setSelected] = useState<AuditLogDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Chain integrity check on mount — the visible trust signal (plan §5.2).
  useEffect(() => {
    let active = true;
    apiClient
      .verifyAuditChain()
      .then((res) => {
        if (active) setChain(res);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setChainError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(() => {
    let active = true;
    setListLoading(true);
    setListError(null);
    apiClient
      .listAuditLogs({ ...applied, to: inclusiveTo(applied.to), page, pageSize: PAGE_SIZE })
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
        setListError(describeError(err, '加载审计日志失败，请稍后重试'));
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applied, page]);

  useEffect(() => load(), [load]);

  function onFilter(e: FormEvent) {
    e.preventDefault();
    setSelected(null);
    setPage(1);
    // Drop empty strings so they are not sent as blank query params.
    const cleaned: ListAuditLogsQuery = { from: draft.from, to: draft.to };
    if (draft.actorType) cleaned.actorType = draft.actorType;
    if (draft.action?.trim()) cleaned.action = draft.action.trim();
    if (draft.resourceType?.trim()) cleaned.resourceType = draft.resourceType.trim();
    if (draft.resourceId?.trim()) cleaned.resourceId = draft.resourceId.trim();
    if (draft.actorId?.trim()) cleaned.actorId = draft.actorId.trim();
    if (draft.requestId?.trim()) cleaned.requestId = draft.requestId.trim();
    setApplied(cleaned);
  }

  async function onSelect(row: AuditLogSummary) {
    setDetailError(null);
    try {
      const fresh = await apiClient.getAuditLog(row.id);
      setSelected(fresh);
    } catch (err) {
      setDetailError(describeError(err, '加载详情失败，请稍后重试'));
    }
  }

  // Exports the CSV for the currently applied filter. Reuses inclusiveTo so the
  // exported set matches the list set on the "today" boundary (plan §6.1).
  async function onExport() {
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await apiClient.exportAuditLogs({
        ...applied,
        to: inclusiveTo(applied.to),
      });
      saveBlob(blob, filename);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setExportError('没有权限导出审计日志');
      else setExportError(describeError(err, '导出失败，请稍后重试'));
    } finally {
      setExporting(false);
    }
  }

  const th: CSSProperties = {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid #ddd',
  };
  const td: CSSProperties = {
    padding: '6px 8px',
    borderBottom: '1px solid #eee',
    verticalAlign: 'top',
  };
  const tag: CSSProperties = {
    fontSize: 11,
    color: '#555',
    background: '#eee',
    borderRadius: 3,
    padding: '1px 5px',
    marginLeft: 6,
  };

  if (forbidden) {
    return (
      <div style={{ fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 20 }}>审计日志</h1>
        <p style={{ color: 'crimson' }}>没有权限查看审计日志</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>审计日志</h1>

      {/* Chain integrity status bar (plan §5.2) */}
      <ChainBar chain={chain} chainError={chainError} />

      {/* Filters (plan §5.3) */}
      <form
        onSubmit={onFilter}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
          margin: '12px 0',
        }}
      >
        <label>
          起始
          <input
            type="date"
            value={draft.from ?? ''}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            style={{ display: 'block' }}
          />
        </label>
        <label>
          结束
          <input
            type="date"
            value={draft.to ?? ''}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            style={{ display: 'block' }}
          />
        </label>
        <label>
          操作者类型
          <select
            value={draft.actorType ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                actorType: (e.target.value || undefined) as AuditActorType | undefined,
              })
            }
            style={{ display: 'block' }}
          >
            <option value="">全部</option>
            <option value="tenant_user">租户用户</option>
            <option value="platform_admin">平台管理员</option>
            <option value="system">系统</option>
          </select>
        </label>
        <label>
          动作
          <input
            value={draft.action ?? ''}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            placeholder="如 user.created"
            style={{ display: 'block' }}
          />
        </label>
        <label>
          资源类型
          <input
            value={draft.resourceType ?? ''}
            onChange={(e) => setDraft({ ...draft, resourceType: e.target.value })}
            placeholder="如 user / role / file"
            style={{ display: 'block' }}
          />
        </label>
        <label>
          资源 ID
          <input
            value={draft.resourceId ?? ''}
            onChange={(e) => setDraft({ ...draft, resourceId: e.target.value })}
            style={{ display: 'block' }}
          />
        </label>
        <label>
          请求 ID
          <input
            value={draft.requestId ?? ''}
            onChange={(e) => setDraft({ ...draft, requestId: e.target.value })}
            style={{ display: 'block' }}
          />
        </label>
        <button type="submit">筛选</button>
        <button type="button" onClick={() => void onExport()} disabled={exporting}>
          {exporting ? '导出中…' : '导出 CSV'}
        </button>
      </form>

      {exportError && <p style={{ color: 'crimson' }}>{exportError}</p>}
      {listError && <p style={{ color: 'crimson' }}>{listError}</p>}

      {listLoading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>所选条件下没有审计事件。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>时间</th>
              <th style={th}>操作者</th>
              <th style={th}>动作</th>
              <th style={th}>资源</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={selected?.id === r.id ? { background: '#f3f7ff' } : undefined}>
                <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={td}>
                  {r.actorName ?? r.actorId}
                  <span style={tag}>{ACTOR_TYPE_LABELS[r.actorType] ?? r.actorType}</span>
                </td>
                <td style={td}>{r.action}</td>
                <td style={td}>
                  {r.resourceType}
                  {r.resourceId ? <span style={{ color: '#888' }}> · {r.resourceId}</span> : null}
                </td>
                <td style={td}>
                  <button onClick={() => onSelect(r)}>详情</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
        <button onClick={() => setPage(page - 1)} disabled={page <= 1}>
          上一页
        </button>
        <span>
          第 {page} / {totalPages} 页 · 共 {total} 条
        </span>
        <button onClick={() => setPage(page + 1)} disabled={page >= totalPages}>
          下一页
        </button>
      </div>

      {detailError && <p style={{ color: 'crimson' }}>{detailError}</p>}
      {selected && <DetailPanel detail={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ChainBar({
  chain,
  chainError,
}: {
  chain: AuditChainVerifyResult | null;
  chainError: boolean;
}) {
  const base: CSSProperties = {
    padding: '8px 12px',
    borderRadius: 4,
    fontSize: 14,
    margin: '4px 0 8px',
  };
  if (chainError) {
    return <div style={{ ...base, background: '#f0f0f0', color: '#666' }}>链状态暂不可用</div>;
  }
  if (!chain) {
    return <div style={{ ...base, background: '#f0f0f0', color: '#666' }}>正在校验审计链…</div>;
  }
  if (chain.ok) {
    return (
      <div style={{ ...base, background: '#e6f6ea', color: '#0a7d23' }}>
        审计链完整 ✓ 共 {chain.total} 条
      </div>
    );
  }
  return (
    <div style={{ ...base, background: '#fdecea', color: '#b00020' }}>
      审计链校验失败：id={chain.failedAt?.id}
      {chain.failedAt?.reason ? `（${chain.failedAt.reason}）` : ''}
    </div>
  );
}

function DetailPanel({ detail, onClose }: { detail: AuditLogDetail; onClose: () => void }) {
  const diff = diffSnapshots(detail.before, detail.after);
  const th: CSSProperties = {
    textAlign: 'left',
    padding: '4px 8px',
    borderBottom: '1px solid #ddd',
    fontSize: 13,
  };
  const td: CSSProperties = {
    padding: '4px 8px',
    borderBottom: '1px solid #eee',
    fontSize: 13,
    verticalAlign: 'top',
  };
  const meta: CSSProperties = { fontSize: 13, margin: '2px 0' };

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>审计详情</strong>
        <button onClick={onClose}>关闭</button>
      </div>

      <div style={{ margin: '8px 0' }}>
        <div style={meta}>ID：{detail.id}</div>
        <div style={meta}>时间：{new Date(detail.createdAt).toLocaleString()}</div>
        <div style={meta}>
          操作者：{detail.actorName ?? detail.actorId}（{detail.actorType}）
        </div>
        <div style={meta}>动作：{detail.action}</div>
        <div style={meta}>
          资源：{detail.resourceType}
          {detail.resourceId ? ` · ${detail.resourceId}` : ''}
        </div>
        {detail.reason ? <div style={meta}>理由：{detail.reason}</div> : null}
        {detail.requestId ? <div style={meta}>请求 ID：{detail.requestId}</div> : null}
        {detail.ipAddress ? <div style={meta}>来源 IP：{detail.ipAddress}</div> : null}
        {detail.userAgent ? (
          <div style={{ ...meta, color: '#888', wordBreak: 'break-all' }}>
            UA：{detail.userAgent}
          </div>
        ) : null}
      </div>

      <strong style={{ fontSize: 14 }}>变更明细</strong>
      {diff === null ? (
        // Fallback: shapes we cannot diff key-by-key — side-by-side JSON.
        <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
          <JsonBlock label="变更前" value={detail.before} />
          <JsonBlock label="变更后" value={detail.after} />
        </div>
      ) : diff.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>本事件没有 before/after 快照。</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 6 }}>
          <thead>
            <tr>
              <th style={th}>字段</th>
              <th style={th}>变更前</th>
              <th style={th}>变更后</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {diff.map((d) => (
              <tr key={d.key} style={d.kind === 'same' ? { color: '#999' } : undefined}>
                <td style={td}>{d.key}</td>
                <td style={td}>{d.kind === 'added' ? '—' : formatValue(d.before)}</td>
                <td style={td}>{d.kind === 'removed' ? '—' : formatValue(d.after)}</td>
                <td style={{ ...td, color: DIFF_COLOR[d.kind] }}>{DIFF_LABEL[d.kind]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.metadata != null && (
        <div style={{ marginTop: 10 }}>
          <strong style={{ fontSize: 14 }}>元数据</strong>
          <JsonBlock value={detail.metadata} />
        </div>
      )}
    </div>
  );
}

function JsonBlock({ label, value }: { label?: string; value: unknown }) {
  return (
    <div style={{ flex: 1 }}>
      {label ? <div style={{ fontSize: 12, color: '#666' }}>{label}</div> : null}
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontSize: 12,
          background: '#f7f7f7',
          padding: 8,
          borderRadius: 4,
          margin: '4px 0 0',
        }}
      >
        {value == null ? '（空）' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

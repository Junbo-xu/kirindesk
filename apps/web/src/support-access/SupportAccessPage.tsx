import { CSSProperties, FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, GrantStatus, SupportGrant } from '../lib/types';

const PAGE_SIZE = 20;

// Effective status is DERIVED in the UI (plan §5.1): the backend only ever
// stores active/revoked this phase, so an `active` row past its expires_at is
// shown as expired (grey), not falsely "live".
type Effective = 'active' | 'expired' | 'revoked' | 'pending';

function effectiveStatus(g: SupportGrant): Effective {
  if (g.status === 'revoked') return 'revoked';
  if (g.status === 'pending') return 'pending';
  if (g.status === 'active') {
    return new Date(g.expiresAt).getTime() <= Date.now() ? 'expired' : 'active';
  }
  // Any stored 'expired' (or unknown) falls through to expired.
  return 'expired';
}

const EFFECTIVE_LABEL: Record<Effective, string> = {
  active: '生效中',
  expired: '已过期',
  revoked: '已撤销',
  pending: '待批',
};

const EFFECTIVE_COLOR: Record<Effective, string> = {
  active: '#0a7d23',
  expired: '#888',
  revoked: '#888',
  pending: '#a60',
};

// A datetime-local value (local time, no zone) 24h from now — the default short
// window for a new grant (plan §5.1). Sliced to minutes for the input.
function defaultExpiry(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 404) return '该平台管理员邮箱不存在或已停用';
  if (err.status === 409) return '该平台管理员已有生效中的授权，请先撤销现有授权';
  if (err.status === 400) return err.message || '请求参数有误（请检查到期时间是否为将来时间）';
  return err.message || fallback;
}

export function SupportAccessPage() {
  const [rows, setRows] = useState<SupportGrant[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<GrantStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setListError(null);
    apiClient
      .listSupportGrants({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter || undefined,
      })
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
        setListError(describeError(err, '加载支持访问授权失败，请稍后重试'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, statusFilter]);

  useEffect(() => load(), [load]);

  if (forbidden) {
    return (
      <div style={{ fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 20 }}>支持访问</h1>
        <p style={{ color: 'crimson' }}>没有权限管理支持访问</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>支持访问</h1>
      <p style={{ color: '#555', fontSize: 14, marginTop: 4 }}>
        授权指定平台管理员在限定时间内只读访问本租户，用于排障支持。每次授权、撤销与平台访问都会记入
        <Link to="/audit-logs?action=support_access.accessed" style={{ marginLeft: 4 }}>
          审计日志
        </Link>
        ，对你可见。
      </p>

      <CreateGrantForm
        onCreated={() => {
          setPage(1);
          load();
        }}
      />

      <GrantList
        rows={rows}
        total={total}
        page={page}
        totalPages={totalPages}
        statusFilter={statusFilter}
        loading={loading}
        listError={listError}
        onStatusFilter={(s) => {
          setStatusFilter(s);
          setPage(1);
        }}
        onPage={setPage}
        onChanged={load}
      />
    </div>
  );
}

function CreateGrantForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    setSubmitting(true);
    try {
      // datetime-local is local wall-clock with no zone; Date() interprets it in
      // the browser's local zone, and toISOString() converts to UTC for the API.
      const iso = new Date(expiresAt).toISOString();
      await apiClient.createSupportGrant({
        platformAdminEmail: email.trim(),
        reason: reason.trim(),
        scope: 'read_only',
        expiresAt: iso,
      });
      setEmail('');
      setReason('');
      setExpiresAt(defaultExpiry());
      setOk(true);
      onCreated();
    } catch (err) {
      setError(describeError(err, '授权失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }

  const label: CSSProperties = { display: 'block', fontSize: 13, marginTop: 10 };
  const input: CSSProperties = { display: 'block', width: '100%', maxWidth: 360 };

  return (
    <form
      onSubmit={onSubmit}
      style={{ border: '1px solid #ddd', borderRadius: 4, padding: 16, margin: '16px 0' }}
    >
      <strong style={{ fontSize: 15 }}>新建授权</strong>
      <label style={label}>
        平台管理员邮箱
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={input}
        />
      </label>
      <label style={label}>
        原因（必填）
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={500}
          placeholder="如：协助排查订单导出异常"
          style={input}
        />
      </label>
      <label style={label}>
        范围
        <input value="只读 (read_only)" disabled style={input} />
      </label>
      <label style={label}>
        到期时间
        <input
          type="datetime-local"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          required
          style={input}
        />
      </label>
      {error && <p style={{ color: 'crimson', fontSize: 13 }}>{error}</p>}
      {ok && <p style={{ color: '#0a7d23', fontSize: 13 }}>授权已创建。</p>}
      <button type="submit" disabled={submitting} style={{ marginTop: 12 }}>
        {submitting ? '提交中…' : '授权'}
      </button>
    </form>
  );
}

interface GrantListProps {
  rows: SupportGrant[];
  total: number;
  page: number;
  totalPages: number;
  statusFilter: GrantStatus | '';
  loading: boolean;
  listError: string | null;
  onStatusFilter: (s: GrantStatus | '') => void;
  onPage: (p: number) => void;
  onChanged: () => void;
}

function GrantList(props: GrantListProps) {
  const { rows, total, page, totalPages, statusFilter, loading, listError } = props;
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmRevoke(id: string) {
    setRevokeError(null);
    setBusy(true);
    try {
      await apiClient.revokeSupportGrant(id, revokeReason.trim());
      setRevokingId(null);
      setRevokeReason('');
      props.onChanged();
    } catch (err) {
      setRevokeError(describeError(err, '撤销失败，请稍后重试'));
    } finally {
      setBusy(false);
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

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', margin: '8px 0' }}>
        <label style={{ fontSize: 13 }}>
          状态筛选
          <select
            value={statusFilter}
            onChange={(e) => props.onStatusFilter((e.target.value || '') as GrantStatus | '')}
            style={{ display: 'block' }}
          >
            <option value="">全部</option>
            <option value="active">生效中</option>
            <option value="revoked">已撤销</option>
            <option value="pending">待批</option>
            <option value="expired">已过期</option>
          </select>
        </label>
      </div>

      {listError && <p style={{ color: 'crimson' }}>{listError}</p>}

      {loading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>暂无支持访问授权。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>平台管理员</th>
              <th style={th}>范围</th>
              <th style={th}>状态</th>
              <th style={th}>授权人</th>
              <th style={th}>到期时间</th>
              <th style={th}>创建时间</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const eff = effectiveStatus(g);
              return (
                <tr key={g.id}>
                  <td style={td}>{g.platformAdminEmail ?? g.platformAdminId}</td>
                  <td style={td}>{g.scope === 'read_only' ? '只读' : g.scope}</td>
                  <td style={{ ...td, color: EFFECTIVE_COLOR[eff] }}>{EFFECTIVE_LABEL[eff]}</td>
                  <td style={td}>{g.grantedByUserId}</td>
                  <td style={td}>{new Date(g.expiresAt).toLocaleString()}</td>
                  <td style={td}>{new Date(g.createdAt).toLocaleString()}</td>
                  <td style={td}>
                    {eff === 'active' ? (
                      <button
                        onClick={() => {
                          setRevokingId(g.id);
                          setRevokeReason('');
                          setRevokeError(null);
                        }}
                      >
                        撤销
                      </button>
                    ) : g.revokeReason ? (
                      <span style={{ color: '#888', fontSize: 12 }}>原因：{g.revokeReason}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
        <button onClick={() => props.onPage(page - 1)} disabled={page <= 1}>
          上一页
        </button>
        <span>
          第 {page} / {totalPages} 页 · 共 {total} 条
        </span>
        <button onClick={() => props.onPage(page + 1)} disabled={page >= totalPages}>
          下一页
        </button>
      </div>

      {revokingId && (
        <div style={{ border: '1px solid #ddd', borderRadius: 4, padding: 12, marginTop: 16 }}>
          <strong>撤销授权</strong>
          <label style={{ display: 'block', fontSize: 13, marginTop: 8 }}>
            撤销原因（必填）
            <input
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              required
              maxLength={500}
              style={{ display: 'block', width: '100%', maxWidth: 360 }}
            />
          </label>
          {revokeError && <p style={{ color: 'crimson', fontSize: 13 }}>{revokeError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              onClick={() => void confirmRevoke(revokingId)}
              disabled={busy || !revokeReason.trim()}
            >
              {busy ? '撤销中…' : '确认撤销'}
            </button>
            <button onClick={() => setRevokingId(null)} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

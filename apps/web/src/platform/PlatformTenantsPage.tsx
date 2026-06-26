import { CSSProperties, useCallback, useEffect, useState } from 'react';
import { platformClient } from '../lib/platform-client';
import { ApiError, PlatformTenantSummary, TenantStatus } from '../lib/types';

// Platform-side tenant lifecycle console (plan §5.3, over the 1K-A endpoints).
// Metadata only — never tenant business data. The three persisted statuses map
// to three actions: suspend (active→suspended), reactivate (suspended|
// deactivated→active), deactivate (active|suspended→deactivated, the terminal
// soft-stop the UI labels "停用/删除"). There is no hard delete.

const STATUS_LABEL: Record<TenantStatus, { text: string; color: string }> = {
  active: { text: '运行中', color: '#0a7d23' },
  suspended: { text: '已暂停', color: '#b8860b' },
  deactivated: { text: '已停用', color: '#888' },
};

const STATUS_FILTERS: { value: '' | TenantStatus; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '运行中' },
  { value: 'suspended', label: '已暂停' },
  { value: 'deactivated', label: '已停用' },
];

const PAGE_SIZE = 20;

type PendingAction = {
  tenant: PlatformTenantSummary;
  action: 'suspend' | 'deactivate' | 'activate';
};

// suspend/deactivate are hard-to-reverse and reason-required; reactivate is a
// recovery and its note is optional. We surface a reason prompt for all three
// so the platform admin always records why (the backend stores it on
// suspend/deactivate and audits it into the tenant chain regardless).
const ACTION_META: Record<
  PendingAction['action'],
  { title: string; verb: string; reasonRequired: boolean; danger: boolean }
> = {
  suspend: { title: '暂停租户', verb: '暂停', reasonRequired: true, danger: true },
  deactivate: { title: '停用租户', verb: '停用', reasonRequired: true, danger: true },
  activate: { title: '恢复租户', verb: '恢复', reasonRequired: false, danger: false },
};

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return '状态不允许此操作（可能已处于目标状态）';
    if (err.status === 404) return '租户不存在';
    if (err.status === 400) return err.message || '请填写有效的原因';
    return err.message;
  }
  return '操作失败，请稍后重试';
}

export function PlatformTenantsPage() {
  const [rows, setRows] = useState<PlatformTenantSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<'' | TenantStatus>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    platformClient
      .listTenants({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter || undefined,
      })
      .then((res) => {
        setRows(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : '加载租户列表失败，请稍后重试');
      })
      .finally(() => setLoading(false));
  }, [page, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

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
  const btn: CSSProperties = { marginRight: 6, cursor: 'pointer' };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>租户</h1>
      <p style={{ color: '#555', fontSize: 14 }}>
        平台运营：仅租户元信息与启停状态，不含任何租户业务数据。每次状态变更都会写入该租户的审计链并对其可见。
      </p>

      <div style={{ margin: '12px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <label>
          状态：
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as '' | TenantStatus);
              setPage(1);
            }}
            style={{ marginLeft: 4 }}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => load()} disabled={loading} style={{ cursor: 'pointer' }}>
          刷新
        </button>
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {loading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>没有匹配的租户。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>名称 / 标识</th>
              <th style={th}>状态</th>
              <th style={th}>暂停原因</th>
              <th style={th}>创建时间</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const s = STATUS_LABEL[t.status] ?? { text: t.status, color: '#333' };
              return (
                <tr key={t.id}>
                  <td style={td}>
                    <div>{t.name}</div>
                    <div style={{ color: '#888', fontSize: 12 }}>{t.slug}</div>
                  </td>
                  <td style={{ ...td, color: s.color }}>{s.text}</td>
                  <td style={{ ...td, color: '#666', fontSize: 12 }}>{t.suspendedReason ?? '—'}</td>
                  <td style={{ ...td, fontSize: 12 }}>{new Date(t.createdAt).toLocaleString()}</td>
                  <td style={td}>
                    {t.status === 'active' && (
                      <button
                        style={btn}
                        onClick={() => setPending({ tenant: t, action: 'suspend' })}
                      >
                        暂停
                      </button>
                    )}
                    {(t.status === 'suspended' || t.status === 'deactivated') && (
                      <button
                        style={btn}
                        onClick={() => setPending({ tenant: t, action: 'activate' })}
                      >
                        恢复
                      </button>
                    )}
                    {(t.status === 'active' || t.status === 'suspended') && (
                      <button
                        style={{ ...btn, color: 'crimson' }}
                        onClick={() => setPending({ tenant: t, action: 'deactivate' })}
                      >
                        停用
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
          上一页
        </button>
        <span style={{ fontSize: 13, color: '#555' }}>
          第 {page} / {totalPages} 页（共 {total} 个租户）
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={loading || page >= totalPages}
        >
          下一页
        </button>
      </div>

      {pending && (
        <ActionDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// Modal-ish inline confirm panel. Suspend/deactivate require a reason; activate
// accepts an optional note. Errors (409 illegal transition, 404, 400 empty
// reason) surface inside the panel without closing it.
function ActionDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const meta = ACTION_META[pending.action];
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setSubmitting(true);
    setError(null);
    const { tenant, action } = pending;
    const call =
      action === 'suspend'
        ? platformClient.suspendTenant(tenant.id, reason)
        : action === 'deactivate'
          ? platformClient.deactivateTenant(tenant.id, reason)
          : platformClient.activateTenant(tenant.id, reason || undefined);
    call
      .then(() => onDone())
      .catch((err) => setError(describeError(err)))
      .finally(() => setSubmitting(false));
  };

  const overlay: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const card: CSSProperties = {
    background: '#fff',
    padding: 20,
    borderRadius: 6,
    width: 420,
    maxWidth: '90vw',
    fontFamily: 'system-ui',
  };

  return (
    <div style={overlay} onClick={submitting ? undefined : onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 17, marginTop: 0 }}>{meta.title}</h2>
        <p style={{ fontSize: 14, color: '#333' }}>
          租户：<strong>{pending.tenant.name}</strong>（{pending.tenant.slug}）
        </p>
        {meta.danger && (
          <p style={{ fontSize: 13, color: '#b8860b' }}>
            {pending.action === 'suspend'
              ? '暂停后该租户用户的访问将被全局闸门拦截，可随时恢复。'
              : '停用后该租户用户将无法访问；数据不会被删除，可后续恢复。'}
          </p>
        )}
        <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
          原因{meta.reasonRequired ? '（必填）' : '（可选）'}
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box' }}
          autoFocus
        />
        {error && <p style={{ color: 'crimson', fontSize: 13 }}>{error}</p>}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            onClick={submit}
            disabled={submitting || (meta.reasonRequired && reason.trim() === '')}
            style={{ color: meta.danger ? 'crimson' : undefined, cursor: 'pointer' }}
          >
            {submitting ? '处理中…' : `确认${meta.verb}`}
          </button>
        </div>
      </div>
    </div>
  );
}

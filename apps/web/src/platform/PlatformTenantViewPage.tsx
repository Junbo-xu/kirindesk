import { CSSProperties, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { platformClient } from '../lib/platform-client';
import {
  ApiError,
  AuditChainVerifyResult,
  AuditLogSummary,
  MyGrant,
  RoleSummary,
  UserSummary,
} from '../lib/types';

type Tab = 'audit' | 'users' | 'roles';
const PAGE_SIZE = 20;

const ACTOR_TYPE_LABELS: Record<string, string> = {
  tenant_user: '租户用户',
  platform_admin: '平台管理员',
  system: '系统',
};

// Read-only authorized view of one tenant (plan §5.3). A prominent banner states
// the access is read-only + recorded + tenant-visible; there are ZERO write
// controls (scope=read_only is structural). No active grant / expired → backend
// SupportAccessGuard returns 403 and the page degrades to a notice.
export function PlatformTenantViewPage() {
  const { tenantId = '' } = useParams();
  const [tab, setTab] = useState<Tab>('audit');
  const [grant, setGrant] = useState<MyGrant | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Resolve the grant terms for the banner from "my grants" (best-effort; the
  // banner still shows generic text if the lookup misses).
  useEffect(() => {
    let active = true;
    platformClient
      .listMyGrants()
      .then((rows) => {
        if (active) setGrant(rows.find((g) => g.tenantId === tenantId) ?? null);
      })
      .catch(() => {
        // banner falls back to generic text; the data calls below are the real
        // authorization signal.
      });
    return () => {
      active = false;
    };
  }, [tenantId]);

  const banner: CSSProperties = {
    background: '#fff4e5',
    border: '1px solid #ffb74d',
    color: '#8a5300',
    borderRadius: 4,
    padding: '10px 14px',
    fontSize: 14,
    margin: '4px 0 16px',
  };

  if (forbidden) {
    return (
      <div style={{ fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 20 }}>租户只读视图</h1>
        <p style={{ color: 'crimson' }}>
          你对该租户没有生效中的支持访问授权（可能未授权或已过期/已撤销）。
        </p>
        <Link to="/platform/support-grants">← 返回我的授权</Link>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <div style={{ marginBottom: 8 }}>
        <Link to="/platform/support-grants">← 返回我的授权</Link>
      </div>
      <h1 style={{ fontSize: 20 }}>租户只读视图</h1>
      <div style={banner}>
        你正以<strong>平台支持访问</strong>身份<strong>只读</strong>查看租户 {tenantId}
        （范围 read_only
        {grant ? `，到期 ${new Date(grant.expiresAt).toLocaleString()}` : ''}
        ）。此访问<strong>已被记录并对该租户可见</strong>。本视图无任何写操作。
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['audit', 'users', 'roles'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ fontWeight: tab === t ? 700 : 400 }}>
            {t === 'audit' ? '审计日志' : t === 'users' ? '用户' : '角色'}
          </button>
        ))}
      </div>

      {tab === 'audit' && <AuditTab tenantId={tenantId} onForbidden={() => setForbidden(true)} />}
      {tab === 'users' && <UsersTab tenantId={tenantId} onForbidden={() => setForbidden(true)} />}
      {tab === 'roles' && <RolesTab tenantId={tenantId} onForbidden={() => setForbidden(true)} />}
    </div>
  );
}

const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ddd' };
const td: CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid #eee',
  verticalAlign: 'top',
};

function handleErr(err: unknown, onForbidden: () => void, setErr: (m: string) => void) {
  if (err instanceof ApiError && err.status === 403) {
    onForbidden();
    return;
  }
  setErr(err instanceof ApiError ? err.message : '加载失败，请稍后重试');
}

function AuditTab({ tenantId, onForbidden }: { tenantId: string; onForbidden: () => void }) {
  const [rows, setRows] = useState<AuditLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [chain, setChain] = useState<AuditChainVerifyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    platformClient
      .tenantAuditChain(tenantId)
      .then((c) => {
        if (active) setChain(c);
      })
      .catch((err) => handleErr(err, onForbidden, () => undefined));
    return () => {
      active = false;
    };
  }, [tenantId, onForbidden]);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    platformClient
      .tenantAuditLogs(tenantId, { page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (!active) return;
        setRows(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (active) handleErr(err, onForbidden, setError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenantId, page, onForbidden]);

  useEffect(() => load(), [load]);

  return (
    <div>
      {chain && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 4,
            fontSize: 14,
            marginBottom: 8,
            background: chain.ok ? '#e6f6ea' : '#fdecea',
            color: chain.ok ? '#0a7d23' : '#b00020',
          }}
        >
          {chain.ok
            ? `审计链完整 ✓ 共 ${chain.total} 条`
            : `审计链校验失败：id=${chain.failedAt?.id}`}
        </div>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>暂无审计事件。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>时间</th>
              <th style={th}>操作者</th>
              <th style={th}>动作</th>
              <th style={th}>资源</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{new Date(r.createdAt).toLocaleString()}</td>
                <td style={td}>
                  {r.actorName ?? r.actorId}
                  <span style={{ fontSize: 11, color: '#555', marginLeft: 6 }}>
                    {ACTOR_TYPE_LABELS[r.actorType] ?? r.actorType}
                  </span>
                </td>
                <td style={td}>{r.action}</td>
                <td style={td}>
                  {r.resourceType}
                  {r.resourceId ? <span style={{ color: '#888' }}> · {r.resourceId}</span> : null}
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
    </div>
  );
}

function UsersTab({ tenantId, onForbidden }: { tenantId: string; onForbidden: () => void }) {
  const [rows, setRows] = useState<UserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    platformClient
      .tenantUsers(tenantId, { page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (!active) return;
        setRows(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (active) handleErr(err, onForbidden, setError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenantId, page, onForbidden]);

  useEffect(() => load(), [load]);

  return (
    <div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>暂无用户。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>邮箱</th>
              <th style={th}>姓名</th>
              <th style={th}>状态</th>
              <th style={th}>所有者</th>
              <th style={th}>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td style={td}>{u.email}</td>
                <td style={td}>{u.name}</td>
                <td style={td}>{u.status}</td>
                <td style={td}>{u.isTenantOwner ? '是' : ''}</td>
                <td style={td}>{new Date(u.createdAt).toLocaleString()}</td>
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
    </div>
  );
}

function RolesTab({ tenantId, onForbidden }: { tenantId: string; onForbidden: () => void }) {
  const [rows, setRows] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    platformClient
      .tenantRoles(tenantId)
      .then((res) => {
        if (active) setRows(res);
      })
      .catch((err) => {
        if (active) handleErr(err, onForbidden, setError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenantId, onForbidden]);

  return (
    <div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>暂无角色。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>名称</th>
              <th style={th}>描述</th>
              <th style={th}>系统角色</th>
              <th style={th}>权限数</th>
              <th style={th}>用户数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.name}</td>
                <td style={td}>{r.description ?? ''}</td>
                <td style={td}>{r.isSystem ? '是' : ''}</td>
                <td style={td}>{r.permissionCount}</td>
                <td style={td}>{r.userCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

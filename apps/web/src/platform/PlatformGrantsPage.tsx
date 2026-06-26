import { CSSProperties, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { platformClient } from '../lib/platform-client';
import { ApiError, MyGrant } from '../lib/types';

// Effective status mirrors the tenant page: an `active` grant past expires_at is
// shown as expired (the platform admin can no longer use it — the backend
// SupportAccessGuard checks now() < expires_at).
function isLive(g: MyGrant): boolean {
  return g.status === 'active' && new Date(g.expiresAt).getTime() > Date.now();
}

function statusLabel(g: MyGrant): { text: string; color: string } {
  if (g.status === 'revoked') return { text: '已撤销', color: '#888' };
  if (isLive(g)) return { text: '生效中', color: '#0a7d23' };
  return { text: '已过期', color: '#888' };
}

// "Which tenants named me?" (plan §5.3/§3.6). Lists the grants naming this
// admin; a live grant links into the read-only tenant view.
export function PlatformGrantsPage() {
  const [rows, setRows] = useState<MyGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    platformClient
      .listMyGrants()
      .then((res) => {
        if (active) setRows(res);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof ApiError ? err.message : '加载授权失败，请稍后重试');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const th: CSSProperties = {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid #ddd',
  };
  const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eee' };

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>我的授权</h1>
      <p style={{ color: '#555', fontSize: 14 }}>
        以下租户指名授权你进行只读支持访问。点击「查看」进入受授权的只读视图；该访问将被记录并对租户可见。
      </p>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {loading ? (
        <p>加载中…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>暂无任何租户授权你访问。</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>租户 ID</th>
              <th style={th}>范围</th>
              <th style={th}>状态</th>
              <th style={th}>到期时间</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => {
              const s = statusLabel(g);
              return (
                <tr key={g.grantId}>
                  <td style={td}>{g.tenantId}</td>
                  <td style={td}>{g.scope === 'read_only' ? '只读' : g.scope}</td>
                  <td style={{ ...td, color: s.color }}>{s.text}</td>
                  <td style={td}>{new Date(g.expiresAt).toLocaleString()}</td>
                  <td style={td}>
                    {isLive(g) ? (
                      <Link to={`/platform/support/tenants/${g.tenantId}`}>查看</Link>
                    ) : (
                      <span style={{ color: '#bbb' }}>不可访问</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

import { CSSProperties, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, RoleSummary } from '../lib/types';

export function RolesListPage() {
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // No roles:view → the whole surface degrades to a notice (graceful-403).
  const [forbidden, setForbidden] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.listRoles();
      setRoles(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : '加载角色失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onDelete(role: RoleSummary) {
    if (!window.confirm(`确认删除角色 ${role.name}？此操作不可撤销。`)) return;
    setError(null);
    try {
      await apiClient.deleteRole(role.id);
      await load();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) setError('角色不存在');
      else if (status === 403) setError('系统角色不可删除，或没有权限');
      else if (status === 409)
        setError(err instanceof ApiError ? err.message : '该角色仍被用户引用，无法删除');
      else setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  const th: CSSProperties = {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid #ddd',
  };
  const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eee' };

  if (forbidden) {
    return (
      <div style={{ fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 20 }}>角色</h1>
        <p style={{ color: '#a60' }}>没有权限查看角色管理。</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>角色</h1>
        <Link to="/roles/new">新建角色</Link>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : roles.length === 0 ? (
        <p>暂无角色</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
          <thead>
            <tr>
              <th style={th}>名称</th>
              <th style={th}>描述</th>
              <th style={th}>类型</th>
              <th style={th}>权限数</th>
              <th style={th}>引用用户</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td style={td}>{r.name}</td>
                <td style={td}>{r.description ?? '-'}</td>
                <td style={td}>{r.isSystem ? '系统' : '自定义'}</td>
                <td style={td}>{r.permissionCount}</td>
                <td style={td}>{r.userCount}</td>
                <td style={td}>
                  {/* System roles are read-only server-side; the UI mirrors that
                      (the server remains the source of truth, not these buttons). */}
                  <Link to={`/roles/${r.id}/edit`}>{r.isSystem ? '查看' : '编辑'}</Link>{' '}
                  <button onClick={() => onDelete(r)} disabled={r.isSystem}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

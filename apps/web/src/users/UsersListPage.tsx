import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, UserStatus, UserSummary } from '../lib/types';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'active', label: '启用' },
  { value: 'inactive', label: '停用' },
];

export function UsersListPage() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  // Applied values drive the fetch; the inputs above are draft state.
  const [appliedStatus, setAppliedStatus] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // No users:view → the whole surface degrades to a notice (graceful-403).
  const [forbidden, setForbidden] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .listUsers({
        page,
        pageSize: PAGE_SIZE,
        q: appliedQ || undefined,
        status: (appliedStatus as UserStatus) || undefined,
      })
      .then((res) => {
        if (!active) return;
        setUsers(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : '加载用户失败，请稍后重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, appliedQ, appliedStatus]);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setAppliedStatus(statusFilter);
    setAppliedQ(q.trim());
  }

  async function reload() {
    setLoading(true);
    try {
      const res = await apiClient.listUsers({
        page,
        pageSize: PAGE_SIZE,
        q: appliedQ || undefined,
        status: (appliedStatus as UserStatus) || undefined,
      });
      setUsers(res.data);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载用户失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  // Enable/disable toggle via PATCH status (keeps the row, reversible). The
  // hard soft-delete endpoint is intentionally not surfaced here.
  async function onToggleStatus(user: UserSummary) {
    const next: UserStatus = user.status === 'active' ? 'inactive' : 'active';
    const verb = next === 'inactive' ? '停用' : '启用';
    if (!window.confirm(`确认${verb}用户 ${user.email}？`)) return;
    setError(null);
    try {
      await apiClient.updateUser(user.id, { status: next });
      await reload();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) setError('用户不存在或已被删除');
      else if (status === 403) setError('没有权限执行该操作');
      else if (status === 409) setError(err instanceof ApiError ? err.message : '操作被拒绝');
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
        <h1 style={{ fontSize: 20 }}>用户</h1>
        <p style={{ color: '#a60' }}>没有权限查看用户管理。</p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>用户</h1>
        <Link to="/users/new">新建用户</Link>
      </div>
      <form
        onSubmit={applyFilters}
        style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center' }}
      >
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索姓名 / 邮箱" />
        <button type="submit">筛选</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : users.length === 0 ? (
        <p>暂无用户</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>姓名</th>
              <th style={th}>邮箱</th>
              <th style={th}>电话</th>
              <th style={th}>状态</th>
              <th style={th}>所有者</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={td}>{u.name}</td>
                <td style={td}>{u.email}</td>
                <td style={td}>{u.phone ?? '-'}</td>
                <td style={td}>{u.status === 'active' ? '启用' : '停用'}</td>
                <td style={td}>{u.isTenantOwner ? '是' : '-'}</td>
                <td style={td}>
                  <Link to={`/users/${u.id}/edit`}>编辑</Link>{' '}
                  <button onClick={() => onToggleStatus(u)}>
                    {u.status === 'active' ? '停用' : '启用'}
                  </button>
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
          第 {page} / {totalPages} 页
        </span>
        <button onClick={() => setPage(page + 1)} disabled={page >= totalPages}>
          下一页
        </button>
      </div>
    </div>
  );
}

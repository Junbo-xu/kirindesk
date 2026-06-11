import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, SupplierResponse } from '../lib/types';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: '启用' },
  { value: 'inactive', label: '停用' },
];

export function SuppliersListPage() {
  const [suppliers, setSuppliers] = useState<SupplierResponse[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  // Applied values drive the fetch; the inputs above are draft state.
  const [appliedStatus, setAppliedStatus] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .listSuppliers({
        page,
        pageSize: PAGE_SIZE,
        q: appliedQ || undefined,
        status: appliedStatus || undefined,
      })
      .then((res) => {
        if (!active) return;
        setSuppliers(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : '加载供应商失败，请稍后重试');
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
      const res = await apiClient.listSuppliers({
        page,
        pageSize: PAGE_SIZE,
        q: appliedQ || undefined,
        status: appliedStatus || undefined,
      });
      setSuppliers(res.data);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载供应商失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  async function onDelete(supplier: SupplierResponse) {
    if (!window.confirm(`确认删除供应商 ${supplier.company_name}？此操作不可撤销。`)) return;
    setError(null);
    try {
      await apiClient.deleteSupplier(supplier.id);
      // Refetch current page; if it was the last row on a page, fall back one.
      if (suppliers.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await reload();
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) setError('供应商不存在或已被删除');
      else if (status === 403) setError('没有权限执行该操作');
      else setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  const th: CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ddd' };
  const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #eee' };

  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>供应商</h1>
        <Link to="/suppliers/new">新建供应商</Link>
      </div>
      <form onSubmit={applyFilters} style={{ display: 'flex', gap: 8, margin: '12px 0', alignItems: 'center' }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索公司名 / 联系人"
        />
        <button type="submit">筛选</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : suppliers.length === 0 ? (
        <p>暂无供应商</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>公司名</th>
              <th style={th}>联系人</th>
              <th style={th}>邮箱</th>
              <th style={th}>电话</th>
              <th style={th}>国家</th>
              <th style={th}>分类</th>
              <th style={th}>状态</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td style={td}>{s.company_name}</td>
                <td style={td}>{s.contact_name ?? '-'}</td>
                <td style={td}>{s.email ?? '-'}</td>
                <td style={td}>{s.phone ?? '-'}</td>
                <td style={td}>{s.country ?? '-'}</td>
                <td style={td}>{s.category ?? '-'}</td>
                <td style={td}>{s.status === 'active' ? '启用' : '停用'}</td>
                <td style={td}>
                  <Link to={`/suppliers/${s.id}/edit`}>编辑</Link>{' '}
                  <button onClick={() => onDelete(s)}>删除</button>
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

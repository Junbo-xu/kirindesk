import { CSSProperties, FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  OrderStatus,
  ORDER_STATUS_LABELS,
  orderStatusLabel,
  SalesOrderResponse,
} from '../lib/types';
import { useCustomerOptions } from './useCustomerOptions';

const PAGE_SIZE = 20;

// All statuses are filterable, including the approval-workflow states.
const STATUS_OPTIONS: { value: OrderStatus; label: string }[] = (
  Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]
).map((value) => ({ value, label: ORDER_STATUS_LABELS[value] }));

export function SalesOrdersListPage() {
  const { options: customers } = useCustomerOptions();
  const [orders, setOrders] = useState<SalesOrderResponse[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  // Applied values drive the fetch; the inputs above are draft state.
  const [appliedStatus, setAppliedStatus] = useState('');
  const [appliedQ, setAppliedQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const customerName = useMemo(() => {
    const map = new Map(customers.map((c) => [c.id, c.company_name]));
    return (id: string) => map.get(id) ?? id;
  }, [customers]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .listSalesOrders({
        page,
        pageSize: PAGE_SIZE,
        q: appliedQ || undefined,
        status: appliedStatus || undefined,
      })
      .then((res) => {
        if (!active) return;
        setOrders(res.data);
        setTotal(res.total);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : '加载订单失败，请稍后重试');
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

  async function onDelete(order: SalesOrderResponse) {
    if (!window.confirm(`确认删除订单 ${order.order_number}？此操作不可撤销。`)) return;
    setError(null);
    try {
      await apiClient.deleteSalesOrder(order.id);
      // Refetch current page; if it was the last row on a page, fall back one.
      if (orders.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await reload();
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) setError('订单不存在或已被删除');
      else if (status === 403) setError('没有权限执行该操作');
      else setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  async function reload() {
    setLoading(true);
    try {
      const res = await apiClient.listSalesOrders({
        page,
        pageSize: PAGE_SIZE,
        q: appliedQ || undefined,
        status: appliedStatus || undefined,
      });
      setOrders(res.data);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载订单失败，请稍后重试');
    } finally {
      setLoading(false);
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20 }}>销售订单</h1>
        <Link to="/orders/new">新建订单</Link>
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
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索订单号 / PI 号" />
        <button type="submit">筛选</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading ? (
        <p>加载中…</p>
      ) : orders.length === 0 ? (
        <p>暂无订单</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>订单号</th>
              <th style={th}>客户</th>
              <th style={th}>币种</th>
              <th style={th}>金额</th>
              <th style={th}>本位币金额</th>
              <th style={th}>状态</th>
              <th style={th}>创建时间</th>
              <th style={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td style={td}>
                  {o.order_number}
                  {o.source_quote_id && (
                    <div style={{ fontSize: 12 }}>
                      <Link to={`/document-workbench?document=${o.source_quote_id}`}>
                        来源报价 {o.source_quote_number} v{o.source_quote_version}
                      </Link>
                    </div>
                  )}
                </td>
                <td style={td}>{customerName(o.customer_id)}</td>
                <td style={td}>{o.currency}</td>
                <td style={td}>{o.total_amount}</td>
                <td style={td}>
                  {o.total_amount_base === null ? (
                    <span style={{ color: '#999' }}>未冻结</span>
                  ) : (
                    o.total_amount_base
                  )}
                </td>
                <td style={td}>{orderStatusLabel(o.status)}</td>
                <td style={td}>{o.created_at}</td>
                <td style={td}>
                  <Link to={`/orders/${o.id}/edit`}>编辑</Link>{' '}
                  <button onClick={() => onDelete(o)}>删除</button>
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

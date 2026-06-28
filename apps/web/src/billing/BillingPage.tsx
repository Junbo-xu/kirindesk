import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, InvoiceSummary } from '../lib/types';

const STATUS_LABELS: Record<string, string> = {
  pending: '待支付',
  paid: '已支付',
  void: '已作废',
};

const STATUS_FILTERS: Array<{ value: '' | 'pending' | 'paid' | 'void'; label: string }> = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待支付' },
  { value: 'paid', label: '已支付' },
  { value: 'void', label: '已作废' },
];

function StatusTag({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    pending: { bg: '#fef3c7', fg: '#92400e' },
    paid: { bg: '#dcfce7', fg: '#166534' },
    void: { bg: '#f3f4f6', fg: '#6b7280' },
  };
  const c = palette[status] ?? { bg: '#f3f4f6', fg: '#374151' };
  return (
    <span
      style={{
        padding: '2px 10px',
        borderRadius: 12,
        fontSize: 12,
        background: c.bg,
        color: c.fg,
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function BillingPage() {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [status, setStatus] = useState<'' | 'pending' | 'paid' | 'void'>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.listInvoices(status ? { status } : {});
      setInvoices(res.data);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 403) {
        setError('没有权限查看账单');
      } else {
        setError(e instanceof Error ? e.message : '加载账单失败');
      }
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pay(id: string) {
    if (payingId) return;
    setPayingId(id);
    setNotice(null);
    setError(null);
    try {
      const updated = await apiClient.payInvoice(id);
      setInvoices((prev) => prev.map((inv) => (inv.id === id ? updated : inv)));
      setNotice(`发票 ${id.slice(0, 8)} 已支付`);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 403) {
        setError('没有权限支付账单');
      } else if (e instanceof ApiError && e.status === 409) {
        setError('该发票当前不可支付（可能已支付或已作废）');
        void load();
      } else if (e instanceof ApiError && e.status === 502) {
        setError('支付渠道处理失败，请稍后重试');
      } else {
        setError(e instanceof Error ? e.message : '支付失败');
      }
    } finally {
      setPayingId(null);
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 880 }}>
      <h1 style={{ fontSize: 20 }}>账单</h1>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: '#555' }}>状态</label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          style={{ padding: '4px 8px', fontSize: 13 }}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {notice && <p style={{ color: '#166534', fontSize: 13 }}>{notice}</p>}
      {error && <p style={{ color: 'crimson', fontSize: 13 }}>{error}</p>}

      {loading ? (
        <p>加载中…</p>
      ) : invoices.length === 0 ? (
        <p style={{ color: '#888' }}>暂无账单</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #e5e7eb' }}>
              <th style={{ padding: '8px 6px' }}>开具时间</th>
              <th style={{ padding: '8px 6px' }}>计费周期</th>
              <th style={{ padding: '8px 6px', textAlign: 'right' }}>金额</th>
              <th style={{ padding: '8px 6px' }}>状态</th>
              <th style={{ padding: '8px 6px' }}>支付时间</th>
              <th style={{ padding: '8px 6px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '8px 6px' }}>{new Date(inv.issuedAt).toLocaleString()}</td>
                <td style={{ padding: '8px 6px' }}>
                  {inv.billingPeriod === 'yearly' ? '年度' : '月度'}
                </td>
                <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                  {inv.currency} {inv.amount}
                </td>
                <td style={{ padding: '8px 6px' }}>
                  <StatusTag status={inv.status} />
                </td>
                <td style={{ padding: '8px 6px', color: '#666' }}>
                  {inv.paidAt ? new Date(inv.paidAt).toLocaleString() : '—'}
                </td>
                <td style={{ padding: '8px 6px' }}>
                  {inv.status === 'pending' ? (
                    <button
                      onClick={() => void pay(inv.id)}
                      disabled={payingId !== null}
                      style={{
                        padding: '4px 12px',
                        fontSize: 13,
                        cursor: payingId !== null ? 'default' : 'pointer',
                      }}
                    >
                      {payingId === inv.id ? '支付中…' : '支付'}
                    </button>
                  ) : (
                    <span style={{ color: '#bbb' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

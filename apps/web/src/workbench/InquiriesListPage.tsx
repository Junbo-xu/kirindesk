import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import { ApiError, InquirySummary } from '../lib/types';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  quoting: '报价中',
  quoted: '已报价',
  selected: '已选价',
};

export function InquiriesListPage() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState<InquirySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .listInquiries()
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : '询盘加载失败'));
  }, []);

  async function submit(row: InquirySummary) {
    setBusy(row.id);
    try {
      const result = await apiClient.submitInquiry(row.id);
      setRows((current) => current.map((item) => (item.id === row.id ? result.inquiry : item)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '提交失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ maxWidth: 1000 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>询盘</h1>
      <p style={{ color: '#64748b' }}>
        仅列出服务端数据范围内的询盘；采购角色无法通过此页面读取客户原文。
      </p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {rows.length === 0 ? (
        <p style={{ color: '#64748b' }}>暂无询盘。</p>
      ) : (
        rows.map((row) => (
          <article
            key={row.id}
            style={{
              background: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: 9,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{row.customer_code}</strong>
              <span>{STATUS_LABELS[row.status] ?? row.status}</span>
            </div>
            <div style={{ color: '#64748b', marginTop: 5 }}>
              {row.customer_country} · {row.items.length} 个产品行
            </div>
            {row.status === 'draft' && hasPermission('inquiries:submit') && (
              <button
                style={{ marginTop: 10 }}
                disabled={busy === row.id}
                onClick={() => void submit(row)}
              >
                {busy === row.id ? '提交中…' : '提交询盘'}
              </button>
            )}
          </article>
        ))
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, QuoteTaskSummary } from '../lib/types';

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  ready: '已就绪',
  timeout: '超时',
  rate_limited: '限流',
  parse_failed: '解析失败',
  provider_failed: '供应商失败',
  manually_corrected: '人工校正',
};

export function QuoteTasksPage() {
  const [rows, setRows] = useState<QuoteTaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .listQuoteTasks()
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : '报价任务加载失败'));
  }, []);

  return (
    <section style={{ maxWidth: 1000 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>报价任务</h1>
      <p style={{ color: '#64748b' }}>采购投影不返回客户名称、联系人、联系方式或客户原文。</p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {rows.length === 0 ? (
        <p style={{ color: '#64748b' }}>暂无报价任务。</p>
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
              <strong>
                {row.customer_country} · {row.items.length} 个产品行
              </strong>
              <span>{STATUS_LABELS[row.sanitization_status] ?? row.sanitization_status}</span>
            </div>
            {row.sanitized_summary && <p>{row.sanitized_summary}</p>}
            {row.last_error_code && (
              <p style={{ color: '#b45309' }}>失败代码：{row.last_error_code}</p>
            )}
            <div style={{ color: '#64748b', fontSize: 12 }}>尝试次数：{row.attempt_count}</div>
          </article>
        ))
      )}
    </section>
  );
}

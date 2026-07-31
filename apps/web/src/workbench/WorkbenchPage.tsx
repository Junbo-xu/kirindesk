import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, WorkbenchResponse } from '../lib/types';

const CAPABILITY_LABELS: Record<string, string> = {
  business: '业务',
  procurement: '采购',
  finance: '财务',
  approver: '审批',
  admin: '管理',
};

function formatAmount(amount: string, currency: string) {
  const [whole, decimal = '00'] = amount.split('.');
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export function WorkbenchPage() {
  const [data, setData] = useState<WorkbenchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiClient
      .getWorkbench()
      .then((response) => {
        if (active) setData(response);
      })
      .catch((err) => {
        if (active) setError(err instanceof ApiError ? err.message : '工作台加载失败');
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!data) return <p style={{ color: '#64748b' }}>正在汇总你的待办…</p>;

  return (
    <section style={{ maxWidth: 1120 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26 }}>角色工作台</h1>
          <p style={{ color: '#64748b', marginTop: 8 }}>
            仅展示你已获授权的数据范围；统计来自实时持久化记录。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {data.capabilities.map((capability) => (
            <span
              key={capability}
              style={{
                borderRadius: 999,
                background: '#dbeafe',
                color: '#1e3a8a',
                padding: '4px 9px',
                fontSize: 12,
              }}
            >
              {CAPABILITY_LABELS[capability] ?? capability}
            </span>
          ))}
        </div>
      </div>

      <h2 style={{ fontSize: 18, marginTop: 30 }}>经营摘要</h2>
      {data.summaries.length === 0 ? (
        <p style={{ color: '#64748b' }}>当前角色没有可展示的经营摘要。</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: 14,
          }}
        >
          {data.summaries.map((summary) => (
            <Link
              key={summary.key}
              to={summary.href}
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: 16,
                background: 'white',
                color: '#0f172a',
                textDecoration: 'none',
              }}
            >
              <div style={{ color: '#64748b', fontSize: 13 }}>{summary.label}</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 7 }}>{summary.value}</div>
              {summary.amount !== undefined && summary.currency && (
                <div style={{ color: '#334155', marginTop: 4 }}>
                  {formatAmount(summary.amount, summary.currency)}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 18, marginTop: 30 }}>待办与异常</h2>
      {data.tasks.length === 0 ? (
        <p style={{ color: '#64748b' }}>当前没有待办。</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {data.tasks.map((task) => (
            <Link
              key={task.key}
              to={task.href}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '13px 16px',
                borderRadius: 9,
                border: `1px solid ${task.urgency === 'critical' ? '#fca5a5' : '#e2e8f0'}`,
                background: task.urgency === 'critical' ? '#fff1f2' : 'white',
                color: '#0f172a',
                textDecoration: 'none',
              }}
            >
              <span>{task.label}</span>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{task.count}</strong>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

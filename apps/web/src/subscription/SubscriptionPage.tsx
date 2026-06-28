import { useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { SubscriptionDetail } from '../lib/types';

function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const over = value >= max;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color: over ? 'crimson' : '#333' }}>
          {value} / {max}
        </span>
      </div>
      <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4 }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: over ? 'crimson' : '#2563eb',
            borderRadius: 4,
            transition: 'width 0.3s',
          }}
        />
      </div>
    </div>
  );
}

export function SubscriptionPage() {
  const [data, setData] = useState<SubscriptionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getSubscription()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!data) return <p>加载中…</p>;

  const { plan, usage, modules } = data;
  const storageGb = Number(usage.storageBytes) / (1024 * 1024 * 1024);

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 640 }}>
      <h1 style={{ fontSize: 20 }}>套餐</h1>

      <section style={{ marginBottom: 24, padding: '16px', border: '1px solid #e5e7eb', borderRadius: 6 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 8 }}>当前套餐</h2>
        <div style={{ fontSize: 22, fontWeight: 600 }}>{plan.name}</div>
        <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
          {plan.expiresAt
            ? `有效期至 ${new Date(plan.expiresAt).toLocaleDateString()}`
            : '永久有效'}
        </div>
      </section>

      <section style={{ marginBottom: 24, padding: '16px', border: '1px solid #e5e7eb', borderRadius: 6 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>配额用量</h2>
        <ProgressBar value={usage.userCount} max={plan.maxUsers} label="用户数" />
        <ProgressBar
          value={Math.round(storageGb * 100) / 100}
          max={plan.maxStorageGb}
          label="存储（GB）"
        />
        <ProgressBar
          value={usage.aiCallsMonth}
          max={plan.aiQuotaMonthly}
          label={`AI 调用（本月，重置于 ${new Date(usage.aiCallsResetAt).toLocaleDateString()}）`}
        />
      </section>

      <section style={{ padding: '16px', border: '1px solid #e5e7eb', borderRadius: 6 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 12 }}>已启用模块</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {modules.map((m) => (
            <span
              key={m.code}
              style={{
                padding: '3px 10px',
                borderRadius: 12,
                fontSize: 13,
                background: m.enabled ? '#dbeafe' : '#f3f4f6',
                color: m.enabled ? '#1d4ed8' : '#9ca3af',
              }}
            >
              {m.name}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

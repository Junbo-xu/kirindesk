import { FormEvent, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, BusinessEvent } from '../lib/types';

export function BusinessTimelinePage() {
  const [chainType, setChainType] = useState('');
  const [chainId, setChainId] = useState('');
  const [applied, setApplied] = useState<{ chainType?: string; chainId?: string }>({});
  const [rows, setRows] = useState<BusinessEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    apiClient
      .listBusinessEvents({ ...applied, pageSize: 100 })
      .then((result) => {
        if (active) setRows(result.data);
      })
      .catch((err) => {
        if (active) setError(err instanceof ApiError ? err.message : '时间线加载失败');
      });
    return () => {
      active = false;
    };
  }, [applied]);

  function apply(event: FormEvent) {
    event.preventDefault();
    if (Boolean(chainType.trim()) !== Boolean(chainId.trim())) {
      setError('凭证类型和凭证 ID 必须同时填写');
      return;
    }
    setApplied(
      chainType.trim() && chainId.trim()
        ? { chainType: chainType.trim(), chainId: chainId.trim() }
        : {},
    );
  }

  return (
    <section style={{ maxWidth: 980 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>业务凭证时间线</h1>
      <p style={{ color: '#64748b' }}>
        时间线只显示凭证引用、事件类型、操作者与时间，不复制客户原文、供应商证据或财务明细。
      </p>
      <form
        onSubmit={apply}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-end', margin: '18px 0' }}
      >
        <label>
          凭证类型
          <input
            value={chainType}
            onChange={(event) => setChainType(event.target.value)}
            placeholder="sales_order"
          />
        </label>
        <label>
          凭证 ID
          <input
            value={chainId}
            onChange={(event) => setChainId(event.target.value)}
            placeholder="UUID"
            style={{ width: 320 }}
          />
        </label>
        <button type="submit">筛选</button>
        <button
          type="button"
          onClick={() => {
            setChainType('');
            setChainId('');
            setApplied({});
          }}
        >
          清除
        </button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {rows.length === 0 ? (
        <p style={{ color: '#64748b' }}>当前授权范围内没有时间线事件。</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <li
              key={row.id}
              style={{ borderLeft: '3px solid #94a3b8', padding: '4px 0 18px 16px' }}
            >
              <strong>{row.eventType}</strong>
              <div style={{ color: '#475569', marginTop: 4 }}>
                {row.credentialType} · {row.credentialId}
              </div>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
                {row.actorName ?? row.actorType} ·{' '}
                {new Date(row.occurredAt).toLocaleString('zh-CN')}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

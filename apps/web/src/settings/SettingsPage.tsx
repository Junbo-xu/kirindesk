import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { ApiError, Currency, SUPPORTED_BASE_CURRENCIES } from '../lib/types';

// Tenant base-currency settings. Reads the current value on mount and lets a
// user with tenant_settings:update change it. Permissions are enforced
// server-side; we surface a 403 as a read-only notice rather than hiding the
// control, matching the rest of the app's graceful-403 handling.
export function SettingsPage() {
  const [current, setCurrent] = useState<Currency | null>(null);
  const [selected, setSelected] = useState<Currency>('RMB');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Set when the server denies the update (no tenant_settings:update); the
  // control becomes read-only.
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .getBaseCurrency()
      .then((res) => {
        if (!active) return;
        setCurrent(res.base_currency);
        setSelected(res.base_currency);
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 403) {
          setReadOnly(true);
          setError('没有权限查看租户设置');
        } else {
          setError(err instanceof ApiError ? err.message : '加载设置失败，请稍后重试');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (selected === current) {
      setSuccess('未做更改');
      return;
    }
    setSaving(true);
    try {
      const res = await apiClient.setBaseCurrency(selected);
      setCurrent(res.base_currency);
      setSelected(res.base_currency);
      setSuccess('已保存');
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setReadOnly(true);
        setError('没有权限修改租户设置');
      } else if (s === 400) {
        setError(err instanceof ApiError ? err.message : '提交数据有误');
      } else {
        setError(err instanceof ApiError ? err.message : '保存失败，请稍后重试');
      }
    } finally {
      setSaving(false);
    }
  }

  const labelStyle: CSSProperties = { display: 'block', marginTop: 12 };

  if (loading) {
    return <p style={{ fontFamily: 'system-ui' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 480, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>租户设置</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          本位币（用于订单本位币金额折算）
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value as Currency)}
            disabled={readOnly || saving}
            style={{ width: '100%' }}
          >
            {SUPPORTED_BASE_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: '#666', fontSize: 12, margin: '4px 0' }}>
          当前本位币：{current ?? '—'}
          。更改后仅影响此后新建/重新保存订单时冻结的汇率快照，历史订单不变。
        </p>
        {error && <p style={{ color: 'crimson', marginTop: 12 }}>{error}</p>}
        {success && <p style={{ color: 'green', marginTop: 12 }}>{success}</p>}
        {!readOnly && (
          <div style={{ marginTop: 16 }}>
            <button type="submit" disabled={saving || selected === current}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CommissionRule } from '../lib/types';
import { td, th } from './styles';

// numeric(7,4) percent: up to 3 integer digits + up to 4 decimals, non-negative.
const RATE_REGEX = /^\d{1,3}(\.\d{1,4})?$/;

interface RuleDraft {
  salespersonId: string;
  rate: string;
}

export function CommissionTableFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [defaultRate, setDefaultRate] = useState('0');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [rules, setRules] = useState<RuleDraft[]>([]);
  // A table backing a locked settlement is read-only server-side (409 on edit);
  // surfaced here as a banner once we hit it.
  const [locked, setLocked] = useState(false);

  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .commissionTable(id)
      .then((t) => {
        if (!active) return;
        setName(t.name);
        setDefaultRate(t.default_rate);
        setStatus(t.status);
        setRules(t.rules.map((r) => ({ salespersonId: r.salespersonId, rate: r.rate })));
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 404) setError('提成规则表不存在');
        else if (s === 403) setError('没有权限查看该提成规则表');
        else setError(err instanceof ApiError ? err.message : '加载失败，请稍后重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  function mapError(err: unknown) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 400) {
      setError(err instanceof ApiError ? err.message : '提交数据有误');
      setFieldErrors(err instanceof ApiError ? (err.fields ?? null) : null);
    } else if (status === 403) {
      setError('没有权限管理提成规则');
    } else if (status === 404) {
      setError('提成规则表不存在');
    } else if (status === 409) {
      setLocked(true);
      setError('该提成规则表已被锁定结算，无法修改');
    } else {
      setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  // Validates the rule drafts locally before sending, so obvious errors don't
  // round-trip. The server re-validates regardless.
  function validateRules(): boolean {
    const seen = new Set<string>();
    for (const r of rules) {
      const sp = r.salespersonId.trim();
      if (sp === '' || !RATE_REGEX.test(r.rate.trim())) {
        setError('每条规则都需要业务员 ID 和合法费率（最多 4 位小数）');
        return false;
      }
      if (seen.has(sp)) {
        setError(`业务员 ${sp} 有重复规则`);
        return false;
      }
      seen.add(sp);
    }
    return true;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors(null);
    if (name.trim() === '') {
      setError('请填写名称');
      return;
    }
    if (!RATE_REGEX.test(defaultRate.trim())) {
      setError('默认费率不合法（最多 4 位小数）');
      return;
    }
    if (!validateRules()) return;

    const cleanRules: CommissionRule[] = rules.map((r) => ({
      salespersonId: r.salespersonId.trim(),
      rate: r.rate.trim(),
    }));

    setSubmitting(true);
    try {
      if (isEdit && id) {
        await apiClient.updateCommissionTable(id, {
          name: name.trim(),
          defaultRate: defaultRate.trim(),
          status,
        });
        await apiClient.replaceCommissionRules(id, { rules: cleanRules });
      } else {
        await apiClient.createCommissionTable({
          name: name.trim(),
          defaultRate: defaultRate.trim(),
          rules: cleanRules,
        });
      }
      navigate('/commission/tables');
    } catch (err) {
      mapError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function addRule() {
    setRules((prev) => [...prev, { salespersonId: '', rate: '' }]);
  }
  function updateRule(i: number, patch: Partial<RuleDraft>) {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  const label: CSSProperties = { display: 'block', margin: '10px 0' };
  const input: CSSProperties = { display: 'block', marginTop: 2, width: 320, maxWidth: '100%' };

  if (loading) return <p style={{ color: '#888' }}>加载中…</p>;

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 720 }}>
      <h1 style={{ fontSize: 20 }}>{isEdit ? '编辑提成规则表' : '新建提成规则表'}</h1>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {fieldErrors && fieldErrors.length > 0 && (
        <ul style={{ color: 'crimson' }}>
          {fieldErrors.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {locked && (
        <p style={{ color: '#a60' }}>该表已用于锁定结算，仅供查看。请新建一张表以调整费率。</p>
      )}

      <form onSubmit={onSubmit}>
        <label style={label}>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={128}
            style={input}
          />
        </label>
        <label style={label}>
          默认费率（%）
          <input
            value={defaultRate}
            onChange={(e) => setDefaultRate(e.target.value)}
            placeholder="例如 5 表示 5%"
            style={input}
          />
        </label>
        {isEdit && (
          <label style={label}>
            状态
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'archived')}
              style={input}
            >
              <option value="active">启用</option>
              <option value="archived">归档</option>
            </select>
          </label>
        )}

        <h2 style={{ fontSize: 16, marginTop: 20 }}>业务员费率（覆盖默认费率）</h2>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>业务员 ID（UUID）</th>
              <th style={th}>费率（%）</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td style={{ ...td, color: '#888' }} colSpan={3}>
                  没有覆盖规则，全部业务员使用默认费率。
                </td>
              </tr>
            )}
            {rules.map((r, i) => (
              <tr key={i}>
                <td style={td}>
                  <input
                    value={r.salespersonId}
                    onChange={(e) => updateRule(i, { salespersonId: e.target.value })}
                    style={{ width: 320, maxWidth: '100%' }}
                  />
                </td>
                <td style={td}>
                  <input
                    value={r.rate}
                    onChange={(e) => updateRule(i, { rate: e.target.value })}
                    style={{ width: 100 }}
                  />
                </td>
                <td style={td}>
                  <button type="button" onClick={() => removeRule(i)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <button type="button" onClick={addRule}>
            + 添加业务员费率
          </button>
        </p>

        <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
          <button type="submit" disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </button>
          <button type="button" onClick={() => navigate('/commission/tables')}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

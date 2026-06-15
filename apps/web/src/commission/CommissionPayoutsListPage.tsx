import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CommissionPayout, CommissionPayoutStatus } from '../lib/types';
import { formatAmount, PAYOUT_STATUS_LABELS, payoutStatusColor } from './format';
import { controlRow, td, tdNum, th, thNum } from './styles';

const STATUS_FILTERS: { value: '' | CommissionPayoutStatus; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'open', label: '待发放' },
  { value: 'paid', label: '已发放' },
  { value: 'void', label: '已作废' },
];

export function CommissionPayoutsListPage() {
  const [rows, setRows] = useState<CommissionPayout[] | null>(null);
  const [status, setStatus] = useState<'' | CommissionPayoutStatus>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await apiClient.commissionPayouts(status ? { status } : {});
      setRows(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setRows(null);
      } else {
        setError(err instanceof ApiError ? err.message : '加载发放单失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 920 }}>
      <h1 style={{ fontSize: 20 }}>发放单</h1>
      <p style={{ fontSize: 13 }}>
        <Link to="/commission">提成汇总</Link> · <Link to="/commission/orders">提成明细</Link> ·{' '}
        <Link to="/commission/tables">提成规则</Link> ·{' '}
        <Link to="/commission/settlements">结算单</Link>
      </p>

      <div style={controlRow}>
        <label>
          状态：
          <select value={status} onChange={(e) => setStatus(e.target.value as '' | CommissionPayoutStatus)}>
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {forbidden && <p style={{ color: 'crimson' }}>没有权限查看发放单</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p style={{ color: '#888' }}>加载中…</p>}

      {!forbidden && rows && rows.length === 0 && (
        <p style={{ color: '#888' }}>
          还没有发放单。请在结算单锁定后，从结算单明细页「生成发放单」。
        </p>
      )}

      {!forbidden && rows && rows.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>结算单</th>
              <th style={th}>状态</th>
              <th style={th}>发放日期</th>
              <th style={th}>外部凭证</th>
              <th style={thNum}>发放合计</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td style={td}>
                  <Link to={`/commission/settlements/${p.settlementId}`}>
                    {p.settlementId.slice(0, 8)}…
                  </Link>
                </td>
                <td style={td}>
                  <span style={{ color: payoutStatusColor(p.status) }}>
                    {PAYOUT_STATUS_LABELS[p.status]}
                  </span>
                </td>
                <td style={td}>{p.payoutDate ?? '—'}</td>
                <td style={td}>{p.externalRef ?? '—'}</td>
                <td style={tdNum}>{formatAmount(p.totalPayoutBase, p.currency)}</td>
                <td style={td}>
                  <Link to={`/commission/payouts/${p.id}`}>明细</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

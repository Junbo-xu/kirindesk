import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CommissionSettlement, COMMISSION_CALIBER_LABELS } from '../lib/types';
import { td, tdNum, th, thNum } from './styles';

const STATUS_LABELS: Record<CommissionSettlement['status'], string> = {
  locked: '已锁定',
  unlocked: '已解锁',
};

// Settlement amounts are base-currency decimal strings; the list has no
// envelope currency, so render the raw grouped number without a code prefix.
function grouped(amount: string): string {
  const [intPart, fracPart = '00'] = amount.split('.');
  const neg = intPart.startsWith('-');
  const digits = neg ? intPart.slice(1) : intPart;
  return `${neg ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fracPart}`;
}

export function CommissionSettlementsListPage() {
  const [rows, setRows] = useState<CommissionSettlement[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await apiClient.commissionSettlements();
      setRows(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setRows(null);
      } else {
        setError(err instanceof ApiError ? err.message : '加载结算单失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 920 }}>
      <h1 style={{ fontSize: 20 }}>结算单</h1>
      <p style={{ fontSize: 13 }}>
        <Link to="/commission">提成汇总</Link> · <Link to="/commission/orders">提成明细</Link> ·{' '}
        <Link to="/commission/tables">提成规则</Link>
      </p>

      {forbidden && <p style={{ color: 'crimson' }}>没有权限查看结算单</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p style={{ color: '#888' }}>加载中…</p>}

      {!forbidden && rows && rows.length === 0 && (
        <p style={{ color: '#888' }}>还没有结算单。可在提成汇总确认无误后锁定一个期间。</p>
      )}

      {!forbidden && rows && rows.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>期间</th>
              <th style={th}>口径</th>
              <th style={th}>状态</th>
              <th style={thNum}>提成合计</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td style={td}>
                  {s.period_start} ~ {s.period_end}
                </td>
                <td style={td}>{COMMISSION_CALIBER_LABELS[s.caliber]}</td>
                <td style={td}>
                  <span style={{ color: s.status === 'locked' ? '#1a7' : '#a60' }}>
                    {STATUS_LABELS[s.status]}
                  </span>
                </td>
                <td style={tdNum}>{grouped(s.total_commission_base)}</td>
                <td style={td}>
                  <Link to={`/commission/settlements/${s.id}`}>明细</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CommissionCaliber,
  COMMISSION_CALIBER_LABELS,
  CommissionSummaryResponse,
} from '../lib/types';
import { defaultRange, formatAmount, formatRate, RATE_SOURCE_LABELS } from './format';
import { controlRow, tag, td, tdNum, th, thNum } from './styles';

export function CommissionSummaryPage() {
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [caliber, setCaliber] = useState<CommissionCaliber>('realized');

  const [data, setData] = useState<CommissionSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server denies the read (no commission_tables:view); the table
  // region degrades to a notice rather than an error screen (plan §6.4).
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await apiClient.commissionSummary({ from, to, caliber });
      setData(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setData(null);
      } else {
        setError(err instanceof ApiError ? err.message : '加载提成汇总失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [from, to, caliber]);

  useEffect(() => {
    void load();
  }, [load]);

  const payable = caliber === 'realized';

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 980 }}>
      <h1 style={{ fontSize: 20 }}>提成汇总</h1>
      <p style={{ fontSize: 13 }}>
        <Link to="/commission/orders">提成明细</Link> ·{' '}
        <Link to="/commission/tables">提成规则</Link> ·{' '}
        <Link to="/commission/settlements">结算单</Link> ·{' '}
        <Link to="/commission/payouts">发放单</Link>
      </p>

      <div style={controlRow}>
        <label>
          起始
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ display: 'block' }}
          />
        </label>
        <label>
          结束
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ display: 'block' }}
          />
        </label>
        <label>
          口径
          <select
            value={caliber}
            onChange={(e) => setCaliber(e.target.value as CommissionCaliber)}
            style={{ display: 'block' }}
          >
            {(Object.keys(COMMISSION_CALIBER_LABELS) as CommissionCaliber[]).map((c) => (
              <option key={c} value={c}>
                {COMMISSION_CALIBER_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {forbidden && <p style={{ color: 'crimson' }}>没有权限查看提成</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {!forbidden && data && (
        <>
          <p style={{ color: '#666', fontSize: 13 }}>
            口径：{COMMISSION_CALIBER_LABELS[data.caliber]} · 金额单位：本位币 {data.currency}
            {!payable && <span style={{ color: '#a60' }}> · 该口径不可发放</span>}
            {data.totals.unCostedCount > 0 && (
              <span style={{ color: '#a60' }}>
                {' '}
                · 未计价订单：{data.totals.unCostedCount} 笔（不计入计提基数）
              </span>
            )}
          </p>
          {data.locked && (
            <p
              style={{
                background: '#eef5ff',
                border: '1px solid #cfe0ff',
                borderRadius: 4,
                padding: '6px 12px',
                color: '#345',
                fontSize: 13,
              }}
            >
              该期间已锁定结算，以下为冻结快照，订单变动不影响这些数字。
            </p>
          )}
          {loading && <p style={{ color: '#888' }}>加载中…</p>}
          {data.rows.length === 0 ? (
            <p style={{ color: '#888' }}>所选范围内没有数据。</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>业务员</th>
                  <th style={thNum}>计提基数</th>
                  <th style={thNum}>提成率</th>
                  <th style={thNum}>提成金额</th>
                  <th style={thNum}>订单数</th>
                  <th style={thNum}>未计价</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const note = RATE_SOURCE_LABELS[row.rateSource];
                  return (
                    <tr key={row.salespersonId}>
                      <td style={td}>{row.salespersonName}</td>
                      <td style={tdNum}>{formatAmount(row.basisBase, data.currency)}</td>
                      <td style={tdNum}>
                        {formatRate(row.rateApplied)}
                        {note && <span style={tag}>{note}</span>}
                      </td>
                      <td style={tdNum}>{formatAmount(row.commissionBase, data.currency)}</td>
                      <td style={tdNum}>{row.orderCount}</td>
                      <td style={tdNum}>{row.unCostedCount > 0 ? row.unCostedCount : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td, fontWeight: 600 }}>合计</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>
                    {formatAmount(data.totals.basisBase, data.currency)}
                  </td>
                  <td style={tdNum}>—</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>
                    {formatAmount(data.totals.commissionBase, data.currency)}
                  </td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>{data.totals.orderCount}</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>
                    {data.totals.unCostedCount > 0 ? data.totals.unCostedCount : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </>
      )}
    </div>
  );
}

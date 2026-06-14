import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  REPORT_CALIBER_LABELS,
  ReportCaliber,
  ReportGranularity,
  ReportGroupBy,
  ReportSummaryResponse,
} from '../lib/types';

type Side = 'sales' | 'purchase';

// Default window: trailing 6 months through today, so the first render shows
// something useful without the user picking dates.
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now);
  fromDate.setMonth(fromDate.getMonth() - 6);
  return { from: fromDate.toISOString().slice(0, 10), to };
}

// Group-by options valid for the selected side (customer for sales, supplier
// for purchase; status/period for both).
function groupByOptions(side: Side): { value: ReportGroupBy; label: string }[] {
  return [
    { value: 'status', label: '按状态' },
    {
      value: side === 'sales' ? 'customer' : 'supplier',
      label: side === 'sales' ? '按客户' : '按供应商',
    },
    { value: 'period', label: '按时间' },
  ];
}

// Renders a base-currency decimal string with thousands separators, prefixed
// with the currency code from the response envelope.
function formatAmount(amount: string, currency: string): string {
  const [intPart, fracPart = '00'] = amount.split('.');
  const neg = intPart.startsWith('-');
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${neg ? '-' : ''}${grouped}.${fracPart}`;
}

export function ReportsPage() {
  const initial = useMemo(defaultRange, []);
  const [side, setSide] = useState<Side>('sales');
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<ReportGroupBy>('status');
  const [granularity, setGranularity] = useState<ReportGranularity>('month');
  const [caliber, setCaliber] = useState<ReportCaliber>('realized');

  const [data, setData] = useState<ReportSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server denies the read (no reports:view). The table region is
  // replaced by a read-only notice, matching the app's graceful-403 handling.
  const [forbidden, setForbidden] = useState(false);

  // If the side changes to one whose entity grouping differs, reset an
  // incompatible groupBy back to status so we never send customer to purchase.
  useEffect(() => {
    if (
      (groupBy === 'customer' && side !== 'sales') ||
      (groupBy === 'supplier' && side !== 'purchase')
    ) {
      setGroupBy('status');
    }
  }, [side, groupBy]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    const query = { from, to, groupBy, granularity, caliber };
    try {
      const res =
        side === 'sales'
          ? await apiClient.salesSummary(query)
          : await apiClient.purchaseSummary(query);
      setData(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setData(null);
      } else {
        setError(err instanceof ApiError ? err.message : '加载报表失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [side, from, to, groupBy, granularity, caliber]);

  // Initial load + reload whenever a control changes.
  useEffect(() => {
    void load();
  }, [load]);

  const th: React.CSSProperties = {
    textAlign: 'left',
    borderBottom: '2px solid #ddd',
    padding: '6px 12px',
  };
  const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: '6px 12px' };
  const tdNum: React.CSSProperties = {
    ...td,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  };

  const groupColLabel =
    groupBy === 'status'
      ? '状态'
      : groupBy === 'period'
        ? '时间'
        : side === 'sales'
          ? '客户'
          : '供应商';

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 920 }}>
      <h1 style={{ fontSize: 20 }}>报表</h1>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
          margin: '12px 0',
        }}
      >
        <label>
          报表
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as Side)}
            style={{ display: 'block' }}
          >
            <option value="sales">销售汇总</option>
            <option value="purchase">采购汇总</option>
          </select>
        </label>
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
          分组
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as ReportGroupBy)}
            style={{ display: 'block' }}
          >
            {groupByOptions(side).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {groupBy === 'period' && (
          <label>
            粒度
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as ReportGranularity)}
              style={{ display: 'block' }}
            >
              <option value="month">按月</option>
              <option value="day">按日</option>
            </select>
          </label>
        )}
        <label>
          口径
          <select
            value={caliber}
            onChange={(e) => setCaliber(e.target.value as ReportCaliber)}
            style={{ display: 'block' }}
          >
            {(Object.keys(REPORT_CALIBER_LABELS) as ReportCaliber[]).map((c) => (
              <option key={c} value={c}>
                {REPORT_CALIBER_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {forbidden && <p style={{ color: 'crimson' }}>没有权限查看报表</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {!forbidden && data && (
        <>
          <p style={{ color: '#666', fontSize: 13 }}>
            口径：{REPORT_CALIBER_LABELS[data.caliber]} · 金额单位：本位币 {data.currency}
            {data.totals.unCostedCount > 0 && (
              <span style={{ color: '#a60' }}>
                {' '}
                · 未计入汇率金额的订单：{data.totals.unCostedCount} 笔
              </span>
            )}
          </p>
          {loading && <p style={{ color: '#888' }}>加载中…</p>}
          {data.rows.length === 0 ? (
            <p style={{ color: '#888' }}>所选范围内没有数据。</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>{groupColLabel}</th>
                  <th style={{ ...th, textAlign: 'right' }}>订单数</th>
                  <th style={{ ...th, textAlign: 'right' }}>本位币金额</th>
                  <th style={{ ...th, textAlign: 'right' }}>未计入</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.key}>
                    <td style={td}>{row.label}</td>
                    <td style={tdNum}>{row.orderCount}</td>
                    <td style={tdNum}>{formatAmount(row.amountBase, data.currency)}</td>
                    <td style={tdNum}>{row.unCostedCount > 0 ? row.unCostedCount : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...td, fontWeight: 600 }}>合计</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>{data.totals.orderCount}</td>
                  <td style={{ ...tdNum, fontWeight: 600 }}>
                    {formatAmount(data.totals.amountBase, data.currency)}
                  </td>
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

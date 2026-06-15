import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CommissionPayoutDetail } from '../lib/types';
import {
  formatAmount,
  PAYOUT_LINE_STATUS_LABELS,
  PAYOUT_STATUS_LABELS,
  payoutStatusColor,
} from './format';
import { td, tdNum, th, thNum } from './styles';

export function CommissionPayoutDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<CommissionPayoutDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Pay-batch form.
  const [payoutDate, setPayoutDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [externalRef, setExternalRef] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await apiClient.commissionPayout(id);
      setData(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setData(null);
      } else if (s === 404) {
        setError('发放单不存在');
      } else {
        setError(err instanceof ApiError ? err.message : '加载发放单失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Maps a write failure to an inline message; reuses the 1F-E mapping
  // (403 → no-permission, 409 → state conflict) (plan §6.4).
  function mapActionError(err: unknown, kind: 'disburse' | 'reverse'): string {
    const s = err instanceof ApiError ? err.status : 0;
    if (s === 403) return kind === 'reverse' ? '没有权限作废发放单' : '没有权限发放';
    if (s === 409) return '发放单状态已变化，请刷新后重试';
    if (s === 404) return '发放单或行不存在';
    return err instanceof ApiError ? err.message : '操作失败，请稍后重试';
  }

  async function run(
    op: () => Promise<CommissionPayoutDetail>,
    kind: 'disburse' | 'reverse',
  ): Promise<void> {
    setActionError(null);
    setBusy(true);
    try {
      setData(await op());
    } catch (err) {
      setActionError(mapActionError(err, kind));
    } finally {
      setBusy(false);
    }
  }

  function onPayLine(lineId: string) {
    if (!id) return;
    void run(() => apiClient.payCommissionPayoutLine(id, lineId), 'disburse');
  }

  function onPayBatch() {
    if (!id) return;
    if (payoutDate.trim() === '') {
      setActionError('请填写发放日期');
      return;
    }
    void run(
      () =>
        apiClient.payCommissionPayout(id, {
          payoutDate,
          externalRef: externalRef.trim() || undefined,
        }),
      'disburse',
    );
  }

  function onVoid() {
    if (!id) return;
    if (voidReason.trim() === '') {
      setActionError('请填写作废原因');
      return;
    }
    void run(() => apiClient.voidCommissionPayout(id, voidReason.trim()), 'reverse');
  }

  if (loading) return <p style={{ color: '#888' }}>加载中…</p>;
  if (forbidden) return <p style={{ color: 'crimson' }}>没有权限查看发放单</p>;
  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!data) return null;

  const isOpen = data.status === 'open';
  const isPaid = data.status === 'paid';

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 920 }}>
      <h1 style={{ fontSize: 20 }}>发放单明细</h1>
      <p style={{ fontSize: 13 }}>
        <Link to="/commission/payouts">← 返回发放单列表</Link> ·{' '}
        <Link to={`/commission/settlements/${data.settlementId}`}>查看结算单</Link>
      </p>

      <p style={{ color: '#666', fontSize: 13 }}>
        状态：
        <span style={{ color: payoutStatusColor(data.status) }}>
          {PAYOUT_STATUS_LABELS[data.status]}
        </span>{' '}
        · 发放合计：{formatAmount(data.totalPayoutBase, data.currency)} · 发放日期：
        {data.payoutDate ?? '—'} · 外部凭证：{data.externalRef ?? '—'}
        {data.note && <> · 备注：{data.note}</>}
      </p>

      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={th}>业务员</th>
            <th style={thNum}>发放金额</th>
            <th style={th}>行状态</th>
            <th style={th}>发放时间</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id}>
              <td style={td}>{l.salespersonName ?? l.salespersonUserId}</td>
              <td style={tdNum}>{formatAmount(l.amountBase, data.currency)}</td>
              <td style={td}>
                <span style={{ color: payoutStatusColor(l.status) }}>
                  {PAYOUT_LINE_STATUS_LABELS[l.status]}
                </span>
              </td>
              <td style={td}>{l.paidAt ? l.paidAt.slice(0, 10) : '—'}</td>
              <td style={td}>
                {isOpen && l.status === 'pending' && (
                  <button type="button" onClick={() => onPayLine(l.id)} disabled={busy}>
                    标记该行已发放
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, fontWeight: 600 }}>合计</td>
            <td style={{ ...tdNum, fontWeight: 600 }}>
              {formatAmount(data.totalPayoutBase, data.currency)}
            </td>
            <td style={td}></td>
            <td style={td}></td>
            <td style={td}></td>
          </tr>
        </tfoot>
      </table>

      {actionError && <p style={{ color: 'crimson', marginTop: 12 }}>{actionError}</p>}

      {(isOpen || isPaid) && (
        <div style={{ marginTop: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          {isOpen && (
            <div style={{ maxWidth: 360 }}>
              <h2 style={{ fontSize: 16 }}>标记整批已发放</h2>
              <p style={{ color: '#666', fontSize: 13 }}>
                将整批及全部待发放行标记为已发放，需要填写发放日期。
              </p>
              <label style={{ display: 'block', marginBottom: 8 }}>
                发放日期：
                <input
                  type="date"
                  value={payoutDate}
                  onChange={(e) => setPayoutDate(e.target.value)}
                />
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>
                外部凭证（可选）：
                <input
                  type="text"
                  value={externalRef}
                  maxLength={128}
                  onChange={(e) => setExternalRef(e.target.value)}
                />
              </label>
              <button type="button" onClick={onPayBatch} disabled={busy}>
                {busy ? '处理中…' : '标记整批已发放'}
              </button>
            </div>
          )}

          <div style={{ maxWidth: 360 }}>
            <h2 style={{ fontSize: 16 }}>作废发放单</h2>
            <p style={{ color: '#666', fontSize: 13 }}>
              作废会将整批及全部行标记为已作废，结算单将可重新生成发放单，需要填写原因。
            </p>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="作废原因"
              rows={2}
              maxLength={500}
              style={{ display: 'block', width: '100%', marginBottom: 8 }}
            />
            <button type="button" onClick={onVoid} disabled={busy}>
              {busy ? '处理中…' : '作废发放单'}
            </button>
          </div>
        </div>
      )}

      {data.status === 'void' && (
        <p style={{ color: '#a60', marginTop: 16 }}>该发放单已作废。</p>
      )}
    </div>
  );
}

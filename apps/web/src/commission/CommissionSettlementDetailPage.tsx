import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CommissionSettlementDetail, COMMISSION_CALIBER_LABELS } from '../lib/types';
import { formatRate } from './format';
import { td, tdNum, th, thNum } from './styles';

// Settlement detail has no envelope currency code; render grouped numbers.
function grouped(amount: string): string {
  const [intPart, fracPart = '00'] = amount.split('.');
  const neg = intPart.startsWith('-');
  const digits = neg ? intPart.slice(1) : intPart;
  return `${neg ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fracPart}`;
}

export function CommissionSettlementDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<CommissionSettlementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [reason, setReason] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Generate-or-view payout: create is idempotent server-side (returns the
  // existing live payout if any), so one button covers both (plan §6.1 / §5.1).
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await apiClient.commissionSettlement(id);
      setData(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setData(null);
      } else if (s === 404) {
        setError('结算单不存在');
      } else {
        setError(err instanceof ApiError ? err.message : '加载结算单失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onUnlock() {
    if (!id) return;
    setActionError(null);
    if (reason.trim() === '') {
      setActionError('请填写解锁原因');
      return;
    }
    setUnlocking(true);
    try {
      const res = await apiClient.unlockCommissionSettlement(id, reason.trim());
      // Unlock appends a new superseding row; navigate the view to it.
      setData(res);
      setReason('');
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) setActionError('没有权限解锁结算单');
      else if (s === 409) setActionError('该结算单当前未处于锁定状态');
      else setActionError(err instanceof ApiError ? err.message : '解锁失败，请稍后重试');
    } finally {
      setUnlocking(false);
    }
  }

  async function onGeneratePayout() {
    if (!id) return;
    setPayoutError(null);
    setPayoutBusy(true);
    try {
      const payout = await apiClient.createCommissionPayout({ settlementId: id });
      navigate(`/commission/payouts/${payout.id}`);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) setPayoutError('没有权限生成发放单');
      else if (s === 409) setPayoutError('该结算单当前未处于锁定状态，无法生成发放单');
      else setPayoutError(err instanceof ApiError ? err.message : '生成发放单失败，请稍后重试');
    } finally {
      setPayoutBusy(false);
    }
  }

  if (loading) return <p style={{ color: '#888' }}>加载中…</p>;
  if (forbidden) return <p style={{ color: 'crimson' }}>没有权限查看结算单</p>;
  if (error) return <p style={{ color: 'crimson' }}>{error}</p>;
  if (!data) return null;

  const isLocked = data.status === 'locked';

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 920 }}>
      <h1 style={{ fontSize: 20 }}>结算单明细</h1>
      <p style={{ fontSize: 13 }}>
        <Link to="/commission/settlements">← 返回结算单列表</Link>
      </p>

      <p style={{ color: '#666', fontSize: 13 }}>
        期间：{data.period_start} ~ {data.period_end} · 口径：
        {COMMISSION_CALIBER_LABELS[data.caliber]} · 状态：
        <span style={{ color: isLocked ? '#1a7' : '#a60' }}>{isLocked ? '已锁定' : '已解锁'}</span>
        {data.uncosted_count > 0 && (
          <span style={{ color: '#a60' }}> · 未计价订单：{data.uncosted_count} 笔</span>
        )}
      </p>

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
          {data.lines.map((l) => (
            <tr key={l.salesperson_user_id}>
              <td style={td}>{l.salesperson_name ?? l.salesperson_user_id}</td>
              <td style={tdNum}>{grouped(l.basis_base)}</td>
              <td style={tdNum}>{formatRate(l.rate_applied)}</td>
              <td style={tdNum}>{grouped(l.commission_base)}</td>
              <td style={tdNum}>{l.order_count}</td>
              <td style={tdNum}>{l.uncosted_count > 0 ? l.uncosted_count : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, fontWeight: 600 }}>合计</td>
            <td style={{ ...tdNum, fontWeight: 600 }}>{grouped(data.total_basis_base)}</td>
            <td style={tdNum}>—</td>
            <td style={{ ...tdNum, fontWeight: 600 }}>{grouped(data.total_commission_base)}</td>
            <td style={tdNum}>—</td>
            <td style={{ ...tdNum, fontWeight: 600 }}>
              {data.uncosted_count > 0 ? data.uncosted_count : '—'}
            </td>
          </tr>
        </tfoot>
      </table>

      {isLocked ? (
        <div style={{ marginTop: 20, maxWidth: 480 }}>
          <h2 style={{ fontSize: 16 }}>发放单</h2>
          <p style={{ color: '#666', fontSize: 13 }}>
            从本结算单生成发放单（金额按结算明细逐笔复制）。若已存在未作废的发放单，将直接打开它。
          </p>
          {payoutError && <p style={{ color: 'crimson' }}>{payoutError}</p>}
          <button type="button" onClick={onGeneratePayout} disabled={payoutBusy}>
            {payoutBusy ? '处理中…' : '生成 / 查看发放单'}
          </button>
        </div>
      ) : (
        <p style={{ color: '#a60', marginTop: 16 }}>结算单已解锁，无法生成发放单。</p>
      )}

      {isLocked ? (
        <div style={{ marginTop: 20, maxWidth: 480 }}>
          <h2 style={{ fontSize: 16 }}>解锁结算单</h2>
          <p style={{ color: '#666', fontSize: 13 }}>
            解锁会追加一条解锁记录（原锁定快照保留不变），需要填写原因。
          </p>
          {actionError && <p style={{ color: 'crimson' }}>{actionError}</p>}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="解锁原因"
            rows={2}
            maxLength={500}
            style={{ display: 'block', width: '100%', marginBottom: 8 }}
          />
          <button type="button" onClick={onUnlock} disabled={unlocking}>
            {unlocking ? '解锁中…' : '解锁'}
          </button>
        </div>
      ) : (
        <p style={{ color: '#a60', marginTop: 16 }}>该结算单已解锁。</p>
      )}
    </div>
  );
}

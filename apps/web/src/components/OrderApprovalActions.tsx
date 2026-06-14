import { CSSProperties, useState } from 'react';
import { ApiError, OrderStatus, orderStatusLabel } from '../lib/types';

// Phase 1F-C approval actions, shared by the sales and purchase order forms.
// Renders the buttons valid for the order's current status and calls back into
// the page-supplied transition handlers (which wrap the api-client methods).
//
//   draft            -> 提交审批 (submit)
//   pending_approval -> 批准 (approve) / 驳回 (reject, needs reason) / 撤回 (withdraw)
//   other statuses   -> no approval actions
//
// Errors are mapped to friendly Chinese messages: 403 -> no permission,
// 409 -> the order moved underneath us (stale view), others -> the API message.

export interface ApprovalHandlers {
  submit: () => Promise<{ status: OrderStatus }>;
  approve: (reason?: string) => Promise<{ status: OrderStatus }>;
  reject: (reason: string) => Promise<{ status: OrderStatus }>;
  withdraw: (reason?: string) => Promise<{ status: OrderStatus }>;
}

interface Props {
  status: OrderStatus;
  handlers: ApprovalHandlers;
  // Called with the new status after any successful transition so the page can
  // refresh its view (status badge, field locks).
  onTransitioned: (next: OrderStatus) => void;
}

function mapApprovalError(err: unknown): string {
  const code = err instanceof ApiError ? err.status : 0;
  if (code === 403) return '没有权限执行该操作';
  if (code === 409) return '订单状态已变化，无法执行该操作，请刷新后重试';
  if (code === 404) return '订单不存在或已被删除';
  if (code === 400) return err instanceof ApiError ? err.message : '提交数据有误';
  return err instanceof ApiError ? err.message : '操作失败，请稍后重试';
}

export function OrderApprovalActions({ status, handlers, onTransitioned }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Reject reason entry is inline (shown when 驳回 is clicked).
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  async function run(action: () => Promise<{ status: OrderStatus }>, label: string) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await action();
      setInfo(`${label}成功，当前状态：${orderStatusLabel(result.status)}`);
      setRejecting(false);
      setReason('');
      onTransitioned(result.status);
    } catch (err) {
      setError(mapApprovalError(err));
    } finally {
      setBusy(false);
    }
  }

  function onRejectClick() {
    setError(null);
    setInfo(null);
    setRejecting(true);
  }

  function onRejectConfirm() {
    if (reason.trim() === '') {
      setError('请填写驳回原因');
      return;
    }
    void run(() => handlers.reject(reason.trim()), '驳回');
  }

  const hasActions = status === 'draft' || status === 'pending_approval';
  if (!hasActions) {
    return null;
  }

  const btn: CSSProperties = { marginRight: 8 };

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>审批</strong>
        <span style={{ color: '#666', fontSize: 13 }}>当前状态：{orderStatusLabel(status)}</span>
      </div>
      <div style={{ marginTop: 10 }}>
        {status === 'draft' && (
          <button
            type="button"
            disabled={busy}
            style={btn}
            onClick={() => void run(handlers.submit, '提交审批')}
          >
            提交审批
          </button>
        )}
        {status === 'pending_approval' && (
          <>
            <button
              type="button"
              disabled={busy}
              style={btn}
              onClick={() => void run(() => handlers.approve(), '批准')}
            >
              批准
            </button>
            <button type="button" disabled={busy} style={btn} onClick={onRejectClick}>
              驳回
            </button>
            <button
              type="button"
              disabled={busy}
              style={btn}
              onClick={() => void run(() => handlers.withdraw(), '撤回')}
            >
              撤回
            </button>
          </>
        )}
      </div>
      {rejecting && (
        <div style={{ marginTop: 10 }}>
          <label style={{ display: 'block', fontSize: 13 }}>
            驳回原因（必填）
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              rows={3}
              style={{ width: '100%' }}
            />
          </label>
          <div style={{ marginTop: 8 }}>
            <button type="button" disabled={busy} style={btn} onClick={onRejectConfirm}>
              确认驳回
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRejecting(false);
                setReason('');
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {error && <p style={{ color: 'crimson', margin: '8px 0 0' }}>{error}</p>}
      {info && <p style={{ color: 'green', margin: '8px 0 0' }}>{info}</p>}
    </div>
  );
}

import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  Currency,
  CreatePurchaseOrderInput,
  OrderStatus,
  UpdatePurchaseOrderInput,
} from '../lib/types';
import { useSupplierOptions } from './useSupplierOptions';

const AMOUNT_RE = /^\d{1,16}(\.\d{1,2})?$/;

const CURRENCY_OPTIONS: Currency[] = ['RMB', 'USD', 'HKD', 'EUR'];

const STATUS_OPTIONS: { value: OrderStatus; label: string }[] = [
  { value: 'draft', label: '草稿' },
  { value: 'confirmed', label: '已确认' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
];

export function PurchaseOrderFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { options: suppliers, loading: suppliersLoading } = useSupplierOptions();

  const [supplierId, setSupplierId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [piNumber, setPiNumber] = useState('');
  const [currency, setCurrency] = useState<Currency>('RMB');
  const [totalAmount, setTotalAmount] = useState('');
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');

  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [orderNumberError, setOrderNumberError] = useState<string | null>(null);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .getPurchaseOrder(id)
      .then((o) => {
        if (!active) return;
        setSupplierId(o.supplier_id);
        setOrderNumber(o.order_number);
        setPiNumber(o.pi_number ?? '');
        setCurrency(o.currency);
        setTotalAmount(o.total_amount);
        setStatus(o.status);
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 404) setError('采购订单不存在或已被删除');
        else if (s === 403) setError('没有权限执行该操作');
        else setError(err instanceof ApiError ? err.message : '加载采购订单失败，请稍后重试');
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
    } else if (status === 403) {
      setError('没有权限执行该操作');
    } else if (status === 404) {
      if (isEdit) setError('采购订单不存在或已被删除');
      else setSupplierError('所选供应商不存在或不可用');
    } else if (status === 409) {
      setOrderNumberError('订单号已存在，请更换');
    } else {
      setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOrderNumberError(null);
    setSupplierError(null);

    if (!AMOUNT_RE.test(totalAmount)) {
      setError('金额格式不正确（最多 16 位整数，2 位小数）');
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && id) {
        const body: UpdatePurchaseOrderInput = {
          pi_number: piNumber.trim() === '' ? undefined : piNumber.trim(),
          currency,
          total_amount: totalAmount,
          status: status as OrderStatus,
          notes: notes.trim() === '' ? undefined : notes.trim(),
        };
        await apiClient.updatePurchaseOrder(id, body);
      } else {
        const body: CreatePurchaseOrderInput = {
          supplier_id: supplierId,
          order_number: orderNumber.trim(),
          currency,
          total_amount: totalAmount,
        };
        if (piNumber.trim() !== '') body.pi_number = piNumber.trim();
        if (status !== '') body.status = status as OrderStatus;
        if (notes.trim() !== '') body.notes = notes.trim();
        await apiClient.createPurchaseOrder(body);
      }
      navigate('/purchase-orders');
    } catch (err) {
      mapError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle: CSSProperties = { display: 'block', marginTop: 12 };

  if (loading) {
    return <p style={{ fontFamily: 'system-ui' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 480, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>{isEdit ? '编辑采购订单' : '新建采购订单'}</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          供应商
          {isEdit ? (
            <input value={supplierId} readOnly style={{ width: '100%' }} />
          ) : (
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              required
              disabled={suppliersLoading}
              style={{ width: '100%' }}
            >
              <option value="">请选择供应商</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.company_name}</option>
              ))}
            </select>
          )}
        </label>
        {supplierError && <p style={{ color: 'crimson', margin: '4px 0' }}>{supplierError}</p>}
        <label style={labelStyle}>
          订单号
          {isEdit ? (
            <input value={orderNumber} readOnly style={{ width: '100%' }} />
          ) : (
            <input
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              required
              maxLength={64}
              style={{ width: '100%' }}
            />
          )}
        </label>
        {orderNumberError && <p style={{ color: 'crimson', margin: '4px 0' }}>{orderNumberError}</p>}
        <label style={labelStyle}>
          PI 号（选填）
          <input
            value={piNumber}
            onChange={(e) => setPiNumber(e.target.value)}
            maxLength={64}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          币种
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            style={{ width: '100%' }}
          >
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          金额
          <input
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            required
            placeholder="例如 1000.00"
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          状态{isEdit ? '' : '（选填，默认草稿）'}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={{ width: '100%' }}
          >
            {!isEdit && <option value="">默认（草稿）</option>}
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          备注（选填）
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={5000}
            rows={4}
            style={{ width: '100%' }}
          />
        </label>
        {error && <p style={{ color: 'crimson', marginTop: 12 }}>{error}</p>}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button type="submit" disabled={submitting}>
            {submitting ? '提交中…' : isEdit ? '保存' : '创建'}
          </button>
          <button type="button" onClick={() => navigate('/purchase-orders')}>取消</button>
        </div>
      </form>
    </div>
  );
}

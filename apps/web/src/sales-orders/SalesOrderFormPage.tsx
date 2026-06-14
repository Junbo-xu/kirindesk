import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  Currency,
  CreateSalesOrderInput,
  OrderItemInput,
  OrderStatus,
  UpdateSalesOrderInput,
} from '../lib/types';
import { computeLineTotal, sumMoney } from '../lib/order-money';
import { useCustomerOptions } from './useCustomerOptions';

const CURRENCY_OPTIONS: Currency[] = ['RMB', 'USD', 'HKD', 'EUR'];

// An editable line row in the form. Mirrors OrderItemInput but every field is a
// string so inputs stay controlled; optional fields are sent only when filled.
interface ItemRow {
  description: string;
  product_code: string;
  unit: string;
  quantity: string;
  unit_price: string;
  notes: string;
}

const EMPTY_ROW: ItemRow = {
  description: '',
  product_code: '',
  unit: '',
  quantity: '',
  unit_price: '',
  notes: '',
};

const QUANTITY_RE = /^\d{1,15}(\.\d{1,3})?$/;
const UNIT_PRICE_RE = /^\d{1,14}(\.\d{1,4})?$/;
// fx_rate: numeric(18,8), strictly positive. Mirrors the server-side DTO regex.
const FX_RATE_RE = /^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,8})?$/;

const STATUS_OPTIONS: { value: OrderStatus; label: string }[] = [
  { value: 'draft', label: '草稿' },
  { value: 'confirmed', label: '已确认' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
];

export function SalesOrderFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { options: customers, loading: customersLoading } = useCustomerOptions();

  const [customerId, setCustomerId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [piNumber, setPiNumber] = useState('');
  const [currency, setCurrency] = useState<Currency>('RMB');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');

  // Phase 1F-B FX. fxRate is an optional manual override input (blank = let the
  // server resolve). The frozen snapshot fields are read-only, populated from the
  // last server response (on load for edit; not known until first save on create).
  const [fxRate, setFxRate] = useState('');
  const [frozenBase, setFrozenBase] = useState<string | null>(null);
  const [frozenSource, setFrozenSource] = useState<string | null>(null);

  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [orderNumberError, setOrderNumberError] = useState<string | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .getSalesOrder(id)
      .then((o) => {
        if (!active) return;
        setCustomerId(o.customer_id);
        setOrderNumber(o.order_number);
        setPiNumber(o.pi_number ?? '');
        setCurrency(o.currency);
        setStatus(o.status);
        // Echo the frozen FX snapshot. Prefill the editable rate with the frozen
        // value so re-saving keeps it unless the user clears/changes it.
        setFxRate(o.fx_rate ?? '');
        setFrozenBase(o.total_amount_base);
        setFrozenSource(o.fx_rate_source);
        // Echo existing line items (ordered by line_no from the API).
        setItems(
          (o.items ?? []).map((it) => ({
            description: it.description,
            product_code: it.product_code ?? '',
            unit: it.unit ?? '',
            quantity: it.quantity,
            unit_price: it.unit_price,
            notes: it.notes ?? '',
          })),
        );
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 404) setError('订单不存在或已被删除');
        else if (s === 403) setError('没有权限执行该操作');
        else setError(err instanceof ApiError ? err.message : '加载订单失败，请稍后重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  // Derived read-only total = Σ line_total, matching the server's derivation.
  const lineTotals = items.map((r) => computeLineTotal(r.quantity, r.unit_price));
  const derivedTotal = sumMoney(lineTotals);

  function updateRow(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setItems((rows) => [...rows, { ...EMPTY_ROW }]);
  }

  function removeRow(index: number) {
    setItems((rows) => rows.filter((_, i) => i !== index));
  }

  // Validates rows and maps them to OrderItemInput. Returns null with an error
  // set if any row is incomplete or malformed.
  function buildItems(): OrderItemInput[] | null {
    const out: OrderItemInput[] = [];
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      if (r.description.trim() === '') {
        setError(`第 ${i + 1} 行：请填写描述`);
        return null;
      }
      if (!QUANTITY_RE.test(r.quantity)) {
        setError(`第 ${i + 1} 行：数量格式不正确（正数，最多 3 位小数）`);
        return null;
      }
      if (!UNIT_PRICE_RE.test(r.unit_price)) {
        setError(`第 ${i + 1} 行：单价格式不正确（非负，最多 4 位小数）`);
        return null;
      }
      const item: OrderItemInput = {
        description: r.description.trim(),
        quantity: r.quantity,
        unit_price: r.unit_price,
      };
      if (r.product_code.trim() !== '') item.product_code = r.product_code.trim();
      if (r.unit.trim() !== '') item.unit = r.unit.trim();
      if (r.notes.trim() !== '') item.notes = r.notes.trim();
      out.push(item);
    }
    return out;
  }

  function mapError(err: unknown) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 400) {
      setError(err instanceof ApiError ? err.message : '提交数据有误');
    } else if (status === 403) {
      setError('没有权限执行该操作');
    } else if (status === 404) {
      if (isEdit) setError('订单不存在或已被删除');
      else setCustomerError('所选客户不存在或不可用');
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
    setCustomerError(null);

    const builtItems = buildItems();
    if (builtItems === null) return;

    const effectiveStatus = status === '' ? 'draft' : (status as OrderStatus);
    if (effectiveStatus !== 'draft' && builtItems.length === 0) {
      setError('非草稿订单至少需要一条行项');
      return;
    }

    // Optional manual rate: validate only when provided. Blank means "let the
    // server resolve" (same-currency=1 or exchange_rates lookup).
    const fxTrimmed = fxRate.trim();
    if (fxTrimmed !== '' && !FX_RATE_RE.test(fxTrimmed)) {
      setError('汇率格式不正确（正数，最多 8 位小数）');
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && id) {
        const body: UpdateSalesOrderInput = {
          pi_number: piNumber.trim() === '' ? undefined : piNumber.trim(),
          currency,
          status: status as OrderStatus,
          notes: notes.trim() === '' ? undefined : notes.trim(),
          items: builtItems,
        };
        if (fxTrimmed !== '') body.fx_rate = fxTrimmed;
        const updated = await apiClient.updateSalesOrder(id, body);
        setFrozenBase(updated.total_amount_base);
        setFrozenSource(updated.fx_rate_source);
      } else {
        const body: CreateSalesOrderInput = {
          customer_id: customerId,
          order_number: orderNumber.trim(),
          currency,
          items: builtItems,
        };
        if (piNumber.trim() !== '') body.pi_number = piNumber.trim();
        if (status !== '') body.status = status as OrderStatus;
        if (notes.trim() !== '') body.notes = notes.trim();
        if (fxTrimmed !== '') body.fx_rate = fxTrimmed;
        await apiClient.createSalesOrder(body);
      }
      navigate('/orders');
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
    <div style={{ maxWidth: 720, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>{isEdit ? '编辑订单' : '新建订单'}</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          客户
          {isEdit ? (
            <input value={customerId} readOnly style={{ width: '100%' }} />
          ) : (
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              required
              disabled={customersLoading}
              style={{ width: '100%' }}
            >
              <option value="">请选择客户</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.company_name}</option>
              ))}
            </select>
          )}
        </label>
        {customerError && <p style={{ color: 'crimson', margin: '4px 0' }}>{customerError}</p>}
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
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>行项</strong>
            <button type="button" onClick={addRow}>
              + 添加行项
            </button>
          </div>
          {items.length === 0 && (
            <p style={{ color: '#666', margin: '8px 0' }}>
              暂无行项。草稿可不填；非草稿订单至少需要一条。
            </p>
          )}
          {items.map((row, i) => {
            const lineTotal = lineTotals[i];
            return (
              <div
                key={i}
                style={{
                  border: '1px solid #ddd',
                  borderRadius: 6,
                  padding: 10,
                  marginTop: 8,
                  display: 'grid',
                  gridTemplateColumns: '1fr 90px 110px 110px auto',
                  gap: 8,
                  alignItems: 'end',
                }}
              >
                <label style={{ fontSize: 13 }}>
                  描述
                  <input
                    value={row.description}
                    onChange={(e) => updateRow(i, { description: e.target.value })}
                    maxLength={500}
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  数量
                  <input
                    value={row.quantity}
                    onChange={(e) => updateRow(i, { quantity: e.target.value })}
                    placeholder="如 2"
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  单价
                  <input
                    value={row.unit_price}
                    onChange={(e) => updateRow(i, { unit_price: e.target.value })}
                    placeholder="如 100.00"
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  小计
                  <input value={lineTotal ?? '—'} readOnly tabIndex={-1} style={{ width: '100%', background: '#f5f5f5' }} />
                </label>
                <button type="button" onClick={() => removeRow(i)} title="删除该行">
                  删除
                </button>
              </div>
            );
          })}
        </div>
        <label style={labelStyle}>
          总金额（自动汇总，不可手填）
          <input value={derivedTotal} readOnly tabIndex={-1} style={{ width: '100%', background: '#f5f5f5' }} />
        </label>
        <label style={labelStyle}>
          汇率（选填，原币种 → 本位币）
          <input
            value={fxRate}
            onChange={(e) => setFxRate(e.target.value)}
            placeholder="留空则由系统按同币种/汇率表解析（最多 8 位小数）"
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          本位币金额（冻结快照，不可手填）
          <input
            value={frozenBase ?? '—'}
            readOnly
            tabIndex={-1}
            style={{ width: '100%', background: '#f5f5f5' }}
          />
        </label>
        <p style={{ color: '#666', fontSize: 12, margin: '4px 0' }}>
          {frozenBase === null
            ? '尚未冻结汇率快照（草稿或暂无可用汇率，保存后可能生成）。'
            : `汇率来源：${
                frozenSource === 'system'
                  ? '同币种（=1）'
                  : frozenSource === 'manual'
                    ? '手动录入'
                    : frozenSource === 'mock'
                      ? '汇率表'
                      : (frozenSource ?? '—')
              }`}
        </p>
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
          <button type="button" onClick={() => navigate('/orders')}>取消</button>
        </div>
      </form>
    </div>
  );
}

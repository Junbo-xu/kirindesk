import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  Currency,
  CreateSalesOrderInput,
  OrderItemInput,
  OrderStatus,
  ORDER_STATUS_LABELS,
  UpdateSalesOrderInput,
} from '../lib/types';
import { computeLineTotal, sumMoney } from '../lib/order-money';
import { OrderApprovalActions } from '../components/OrderApprovalActions';
import { useCustomerOptions } from './useCustomerOptions';
import { useAuth } from '../auth/AuthContext';
import type { ProductRecord } from '../lib/types';

const CURRENCY_OPTIONS: Currency[] = ['RMB', 'USD', 'HKD', 'EUR'];

// An editable line row in the form. Mirrors OrderItemInput but every field is a
// string so inputs stay controlled; optional fields are sent only when filled.
interface ItemRow {
  product_id: string;
  description: string;
  product_code: string;
  unit: string;
  quantity: string;
  unit_price: string;
  notes: string;
}

const EMPTY_ROW: ItemRow = {
  product_id: '',
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

// Statuses settable directly via the create/update form. The approval-workflow
// states (pending_approval/approved/rejected) are reachable only through the
// transition endpoints, so they are not offered here (matches the server DTO).
const STATUS_OPTIONS: { value: OrderStatus; label: string }[] = [
  { value: 'draft', label: ORDER_STATUS_LABELS.draft },
  { value: 'confirmed', label: ORDER_STATUS_LABELS.confirmed },
  { value: 'completed', label: ORDER_STATUS_LABELS.completed },
  { value: 'cancelled', label: ORDER_STATUS_LABELS.cancelled },
];

export function SalesOrderFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { options: customers, loading: customersLoading } = useCustomerOptions();

  const [customerId, setCustomerId] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [piNumber, setPiNumber] = useState('');
  const [currency, setCurrency] = useState<Currency>('RMB');
  const [items, setItems] = useState<ItemRow[]>([]);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceQuote, setSourceQuote] = useState<{
    documentSetId: string;
    quoteNumber: string;
    version: number;
  } | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [fulfillmentLockedAt, setFulfillmentLockedAt] = useState<string | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowNotice, setWorkflowNotice] = useState<string | null>(null);
  const [documentSetId, setDocumentSetId] = useState<string | null>(null);

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
    let active = true;
    apiClient
      .listProducts({ active: true, pageSize: 100 })
      .then((result) => {
        if (active) setProducts(result.data);
      })
      .catch(() => {
        if (active) setProducts([]);
      });
    return () => {
      active = false;
    };
  }, []);

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
        setUpdatedAt(o.updated_at);
        setFulfillmentLockedAt(o.fulfillment_locked_at);
        setSourceQuote(
          o.source_document_set_id && o.source_quote_number && o.source_quote_version
            ? {
                documentSetId: o.source_document_set_id,
                quoteNumber: o.source_quote_number,
                version: o.source_quote_version,
              }
            : null,
        );
        // Echo the frozen FX snapshot. Prefill the editable rate with the frozen
        // value so re-saving keeps it unless the user clears/changes it.
        setFxRate(o.fx_rate ?? '');
        setFrozenBase(o.total_amount_base);
        setFrozenSource(o.fx_rate_source);
        // Echo existing line items (ordered by line_no from the API).
        setItems(
          (o.items ?? []).map((it) => ({
            product_id: it.product_id ?? '',
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

  // Order is in an approval-workflow state (managed via the transition actions,
  // not the editable status select).
  const isApprovalState =
    status === 'pending_approval' || status === 'approved' || status === 'rejected';
  const fulfillmentLocked = fulfillmentLockedAt !== null;
  const canLockForFulfillment = hasPermission('orders:update');
  const canSyncDocuments = hasPermission('document_sets:manage');
  const canGeneratePurchaseOrders = hasPermission('procurement:create');

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
      if (r.product_id) item.product_id = r.product_id;
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

  function chooseProduct(index: number, productId: string) {
    const selected = products.find((product) => product.id === productId);
    if (!selected) {
      updateRow(index, { product_id: '' });
      return;
    }
    updateRow(index, {
      product_id: selected.id,
      description: selected.name,
      product_code: selected.sku,
      unit: selected.unit,
      unit_price: selected.default_unit_price,
    });
  }

  async function lockForFulfillment() {
    if (!id || !updatedAt) return;
    setWorkflowBusy(true);
    setError(null);
    setWorkflowNotice(null);
    try {
      const result = await apiClient.lockSalesOrderForFulfillment(id, updatedAt);
      setUpdatedAt(result.sales_order.updated_at);
      setFulfillmentLockedAt(result.sales_order.fulfillment_locked_at);
      setWorkflowNotice(result.idempotent ? '订单已处于履约锁定状态。' : '订单履约快照已锁定。');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '锁定订单失败');
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function syncDocuments() {
    if (!id || !updatedAt) return;
    setWorkflowBusy(true);
    setError(null);
    setWorkflowNotice(null);
    try {
      const result = await apiClient.syncSalesOrderDocuments(id, {
        idempotency_key: `order-documents:${id}:${updatedAt}`,
        expected_updated_at: updatedAt,
      });
      setDocumentSetId(result.document.document_set_id);
      setWorkflowNotice(
        result.refreshed
          ? `PI / SC / CI / PL 已刷新；保留 ${result.preserved_export_count} 份历史导出。`
          : 'PI / SC / CI / PL 已从当前订单版本生成。',
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '生成订单单证失败');
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function generatePurchaseOrders() {
    if (!id) return;
    setWorkflowBusy(true);
    setError(null);
    setWorkflowNotice(null);
    try {
      const result = await apiClient.generateSalesOrderPurchaseOrders(
        id,
        `order-purchase-orders:${id}`,
      );
      setWorkflowNotice(`已按供应商拆分生成 ${result.purchase_orders.length} 张采购单。`);
    } catch (caught) {
      if (caught instanceof ApiError && Array.isArray(caught.details?.missing)) {
        const missing = caught.details.missing as Array<{
          line_no: number;
          missing_fields: string[];
        }>;
        setError(
          `采购映射不完整：${missing
            .map((item) => `第 ${item.line_no} 行缺少 ${item.missing_fields.join('/')}`)
            .join('；')}`,
        );
      } else {
        setError(caught instanceof ApiError ? caught.message : '生成采购单失败');
      }
    } finally {
      setWorkflowBusy(false);
    }
  }

  const labelStyle: CSSProperties = { display: 'block', marginTop: 12 };

  if (loading) {
    return <p style={{ fontFamily: 'system-ui' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 720, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>{isEdit ? '编辑订单' : '新建订单'}</h1>
      {sourceQuote && (
        <p>
          来源报价：
          <Link to={`/documents?document=${sourceQuote.documentSetId}`}>
            {sourceQuote.quoteNumber} v{sourceQuote.version}
          </Link>
        </p>
      )}
      {fulfillmentLockedAt && (
        <p style={{ color: '#166534', background: '#f0fdf4', padding: 10 }}>
          履约快照已锁定：{new Date(fulfillmentLockedAt).toLocaleString()}。订单事实不可再编辑。
        </p>
      )}
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
                <option key={c.id} value={c.id}>
                  {c.company_name}
                </option>
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
        {orderNumberError && (
          <p style={{ color: 'crimson', margin: '4px 0' }}>{orderNumberError}</p>
        )}
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
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>行项</strong>
            <button type="button" onClick={addRow} disabled={fulfillmentLocked}>
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
                  gridTemplateColumns: '180px 1fr 90px 110px 110px auto',
                  gap: 8,
                  alignItems: 'end',
                }}
              >
                <label style={{ fontSize: 13 }}>
                  产品
                  <select
                    value={row.product_id}
                    disabled={fulfillmentLocked}
                    onChange={(event) => chooseProduct(i, event.target.value)}
                    style={{ width: '100%' }}
                  >
                    <option value="">未关联产品</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.sku} · {product.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ fontSize: 13 }}>
                  描述
                  <input
                    disabled={fulfillmentLocked}
                    value={row.description}
                    onChange={(e) => updateRow(i, { description: e.target.value })}
                    maxLength={500}
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  数量
                  <input
                    disabled={fulfillmentLocked}
                    value={row.quantity}
                    onChange={(e) => updateRow(i, { quantity: e.target.value })}
                    placeholder="如 2"
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  单价
                  <input
                    disabled={fulfillmentLocked}
                    value={row.unit_price}
                    onChange={(e) => updateRow(i, { unit_price: e.target.value })}
                    placeholder="如 100.00"
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ fontSize: 13 }}>
                  小计
                  <input
                    value={lineTotal ?? '—'}
                    readOnly
                    tabIndex={-1}
                    style={{ width: '100%', background: '#f5f5f5' }}
                  />
                </label>
                <button
                  type="button"
                  disabled={fulfillmentLocked}
                  onClick={() => removeRow(i)}
                  title="删除该行"
                >
                  删除
                </button>
              </div>
            );
          })}
        </div>
        <label style={labelStyle}>
          总金额（自动汇总，不可手填）
          <input
            value={derivedTotal}
            readOnly
            tabIndex={-1}
            style={{ width: '100%', background: '#f5f5f5' }}
          />
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
          {isApprovalState ? (
            // pending_approval/approved/rejected are managed via the approval
            // actions below, not editable here.
            <input
              value={ORDER_STATUS_LABELS[status as OrderStatus] ?? status}
              readOnly
              tabIndex={-1}
              style={{ width: '100%', background: '#f5f5f5' }}
            />
          ) : (
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              style={{ width: '100%' }}
            >
              {!isEdit && <option value="">默认（草稿）</option>}
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
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
          <button type="submit" disabled={submitting || fulfillmentLocked}>
            {submitting ? '提交中…' : isEdit ? '保存' : '创建'}
          </button>
          <button type="button" onClick={() => navigate('/orders')}>
            取消
          </button>
        </div>
      </form>
      {isEdit && id && (
        <section
          style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: 12, marginTop: 20 }}
        >
          <strong>履约生成</strong>
          <p style={{ color: '#64748b', fontSize: 13 }}>
            单证可在锁定前按订单版本刷新；采购单只从履约锁定快照生成，并继续走既有采购审批。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canLockForFulfillment && (
              <button
                type="button"
                disabled={workflowBusy || fulfillmentLocked}
                onClick={() => void lockForFulfillment()}
              >
                锁定履约快照
              </button>
            )}
            {canSyncDocuments && (
              <button type="button" disabled={workflowBusy} onClick={() => void syncDocuments()}>
                生成 / 刷新 PI、SC、CI、PL
              </button>
            )}
            {canGeneratePurchaseOrders && (
              <button
                type="button"
                disabled={workflowBusy || !fulfillmentLocked}
                onClick={() => void generatePurchaseOrders()}
              >
                按供应商生成采购单
              </button>
            )}
            {documentSetId && (
              <Link to={`/documents?document=${documentSetId}`}>打开单证工作台</Link>
            )}
          </div>
          {workflowNotice && <p style={{ color: '#166534' }}>{workflowNotice}</p>}
        </section>
      )}
      {isEdit && id && (
        <OrderApprovalActions
          status={status as OrderStatus}
          handlers={{
            submit: () =>
              apiClient.submitSalesOrder(id).then((next) => {
                setUpdatedAt(next.updated_at);
                return next;
              }),
            approve: (reason) =>
              apiClient.approveSalesOrder(id, reason).then((next) => {
                setUpdatedAt(next.updated_at);
                return next;
              }),
            reject: (reason) =>
              apiClient.rejectSalesOrder(id, reason).then((next) => {
                setUpdatedAt(next.updated_at);
                return next;
              }),
            withdraw: (reason) =>
              apiClient.withdrawSalesOrder(id, reason).then((next) => {
                setUpdatedAt(next.updated_at);
                return next;
              }),
          }}
          onTransitioned={(next) => setStatus(next)}
        />
      )}
    </div>
  );
}

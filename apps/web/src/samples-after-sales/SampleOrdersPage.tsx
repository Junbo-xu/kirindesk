import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CommercialSelection,
  Currency,
  InquirySummary,
  SampleOrder,
  SampleOrderStatus,
} from '../lib/types';
import './SamplesAfterSales.css';

const statusLabel: Record<SampleOrderStatus, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  dispatched: '已寄出',
  delivered: '已送达',
  confirmed: '客户已确认',
  converted: '已转正式订单',
  closed: '已关闭',
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : '操作失败';
}

function localDateTime(): string {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return now.toISOString().slice(0, 16);
}

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}

export function SampleOrdersPage() {
  const { hasPermission } = useAuth();
  const [samples, setSamples] = useState<SampleOrder[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [inquiries, setInquiries] = useState<InquirySummary[]>([]);
  const [selections, setSelections] = useState<CommercialSelection[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inquiryId, setInquiryId] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [recipientCountry, setRecipientCountry] = useState('');
  const [shippingFee, setShippingFee] = useState('0.00');
  const [shippingCurrency, setShippingCurrency] = useState<Currency>('RMB');
  const [note, setNote] = useState('');
  const [sampleQuantities, setSampleQuantities] = useState<Record<string, string>>({});

  const [decisionReason, setDecisionReason] = useState('');
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [dispatchedAt, setDispatchedAt] = useState(localDateTime);
  const [receivedBy, setReceivedBy] = useState('');
  const [deliveredAt, setDeliveredAt] = useState(localDateTime);
  const [feedback, setFeedback] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [conversionQuantities, setConversionQuantities] = useState<Record<string, string>>({});
  const [closeReason, setCloseReason] = useState('');

  const selected = useMemo(
    () => samples.find((sample) => sample.id === selectedId) ?? null,
    [samples, selectedId],
  );

  async function loadSamples(preferredId?: string) {
    const rows = await apiClient.listSampleOrders();
    setSamples(rows);
    setSelectedId((current) => preferredId || current || rows[0]?.id || '');
  }

  useEffect(() => {
    void loadSamples().catch((caught) => setError(errorMessage(caught)));
    if (hasPermission('sample_orders:create')) {
      void apiClient
        .listInquiries()
        .then((rows) => setInquiries(rows.filter((row) => row.customer_id)))
        .catch((caught) => setError(errorMessage(caught)));
    }
  }, []);

  useEffect(() => {
    if (!inquiryId) {
      setSelections([]);
      setSampleQuantities({});
      return;
    }
    void apiClient
      .listSelections(inquiryId)
      .then((rows) => {
        const eligible = rows.filter((row) => row.commercial);
        setSelections(eligible);
        setSampleQuantities(Object.fromEntries(eligible.map((row) => [row.id, ''])));
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, [inquiryId]);

  useEffect(() => {
    if (!selected) return;
    setConversionQuantities(
      Object.fromEntries(selected.items.map((item) => [item.id, item.sample_quantity])),
    );
    setDecisionReason('');
    setCloseReason('');
  }, [selected?.id]);

  async function run(action: () => Promise<unknown>, preferredId = selectedId) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadSamples(preferredId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createSample(event: FormEvent) {
    event.preventDefault();
    const items = Object.entries(sampleQuantities)
      .filter(([, quantity]) => Number(quantity) > 0)
      .map(([selection_id, quantity]) => ({ selection_id, quantity }));
    if (items.length === 0) {
      setError('至少填写一个有效的样品数量');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await apiClient.createSampleOrder({
        inquiry_id: inquiryId,
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        recipient_address: recipientAddress,
        recipient_country: recipientCountry,
        shipping_fee: shippingFee,
        shipping_currency: shippingCurrency,
        note: note.trim() || undefined,
        items,
      });
      setShowCreate(false);
      setInquiryId('');
      setRecipientName('');
      setRecipientPhone('');
      setRecipientAddress('');
      setRecipientCountry('');
      setNote('');
      await loadSamples(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function decide(decision: 'approved' | 'rejected') {
    if (!selected) return;
    if (decision === 'rejected' && !decisionReason.trim()) {
      setError('拒绝样品单必须填写原因');
      return;
    }
    void run(() =>
      apiClient.decideSampleOrder(selected.id, decision, decisionReason.trim() || undefined),
    );
  }

  function dispatch(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void run(() =>
      apiClient.dispatchSampleOrder(selected.id, {
        carrier,
        tracking_number: trackingNumber,
        dispatched_at: new Date(dispatchedAt).toISOString(),
      }),
    );
  }

  function deliver(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void run(() =>
      apiClient.deliverSampleOrder(selected.id, {
        received_by: receivedBy,
        delivered_at: new Date(deliveredAt).toISOString(),
      }),
    );
  }

  function convert(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void run(() =>
      apiClient.convertSampleOrder(selected.id, {
        payment_terms: paymentTerms,
        items: selected.items.map((item) => ({
          sample_item_id: item.id,
          quantity: conversionQuantities[item.id] || '0',
        })),
      }),
    );
  }

  return (
    <section className="ops-workspace">
      <header className="ops-heading">
        <div>
          <h1>样品单</h1>
          <p>寄样、客户确认与正式订单转换</p>
        </div>
        {hasPermission('sample_orders:create') && (
          <button
            className="ops-button"
            type="button"
            onClick={() => setShowCreate((current) => !current)}
          >
            {showCreate ? '取消新建' : '新建样品单'}
          </button>
        )}
      </header>

      {error && (
        <div className="ops-alert" role="alert">
          {error}
        </div>
      )}

      {showCreate && (
        <form className="ops-create" onSubmit={createSample}>
          <div className="ops-section-header">
            <h2>新样品单</h2>
            <span>{selections.length} 个已冻结选价</span>
          </div>
          <div className="ops-form-grid three">
            <label className="ops-field">
              询盘
              <select
                required
                value={inquiryId}
                onChange={(event) => setInquiryId(event.target.value)}
              >
                <option value="">选择询盘</option>
                {inquiries.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.customer_code} · {row.customer_country}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-field">
              收件人
              <input
                required
                maxLength={120}
                value={recipientName}
                onChange={(event) => setRecipientName(event.target.value)}
              />
            </label>
            <label className="ops-field">
              联系电话
              <input
                required
                maxLength={60}
                value={recipientPhone}
                onChange={(event) => setRecipientPhone(event.target.value)}
              />
            </label>
            <label className="ops-field wide">
              收件地址
              <input
                required
                maxLength={1000}
                value={recipientAddress}
                onChange={(event) => setRecipientAddress(event.target.value)}
              />
            </label>
            <label className="ops-field">
              国家或地区
              <input
                required
                maxLength={100}
                value={recipientCountry}
                onChange={(event) => setRecipientCountry(event.target.value)}
              />
            </label>
            <label className="ops-field">
              寄送费用
              <span className="ops-inline-field">
                <input
                  required
                  inputMode="decimal"
                  value={shippingFee}
                  onChange={(event) => setShippingFee(event.target.value)}
                />
                <select
                  value={shippingCurrency}
                  onChange={(event) => setShippingCurrency(event.target.value as Currency)}
                >
                  {(['RMB', 'USD', 'HKD', 'EUR'] as const).map((currency) => (
                    <option key={currency}>{currency}</option>
                  ))}
                </select>
              </span>
            </label>
            <label className="ops-field wide">
              备注
              <input
                maxLength={1000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>
          {selections.length > 0 && (
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>选价产品</th>
                    <th>销售价</th>
                    <th>报价数量</th>
                    <th>样品数量</th>
                  </tr>
                </thead>
                <tbody>
                  {selections.map((selection) => (
                    <tr key={selection.id}>
                      <td>{selection.snapshot.inquiry_item.description}</td>
                      <td>
                        {selection.commercial?.sales_currency}{' '}
                        {selection.commercial?.sales_unit_price}
                      </td>
                      <td>
                        {selection.snapshot.inquiry_item.quantity}{' '}
                        {selection.snapshot.inquiry_item.unit}
                      </td>
                      <td>
                        <input
                          aria-label={`${selection.snapshot.inquiry_item.description}样品数量`}
                          inputMode="decimal"
                          value={sampleQuantities[selection.id] ?? ''}
                          onChange={(event) =>
                            setSampleQuantities((current) => ({
                              ...current,
                              [selection.id]: event.target.value,
                            }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ops-actions">
            <button className="ops-button" disabled={busy}>
              创建草稿
            </button>
          </div>
        </form>
      )}

      <div className="ops-grid">
        <aside className="ops-list" aria-label="样品单列表">
          <h2>样品记录</h2>
          {samples.length === 0 && <p className="ops-muted">暂无样品单</p>}
          {samples.map((sample) => (
            <button
              key={sample.id}
              type="button"
              aria-current={selectedId === sample.id}
              onClick={() => setSelectedId(sample.id)}
            >
              <strong>{sample.sample_number}</strong>
              <span>
                {statusLabel[sample.status]} · {sample.items.length} 项
              </span>
            </button>
          ))}
        </aside>

        <div className="ops-detail">
          {!selected && <div className="ops-empty">选择一张样品单查看详情</div>}
          {selected && (
            <>
              <header className="ops-record-header">
                <div>
                  <h2>{selected.sample_number}</h2>
                  <p>创建于 {dateTime(selected.created_at)}</p>
                </div>
                <span className={`ops-badge ${selected.status}`}>
                  {statusLabel[selected.status]}
                </span>
              </header>

              <section className="ops-section">
                <h3>收件与寄送</h3>
                <dl className="ops-facts">
                  <div>
                    <dt>收件人</dt>
                    <dd>{selected.recipient.name}</dd>
                  </div>
                  <div>
                    <dt>联系电话</dt>
                    <dd>{selected.recipient.phone}</dd>
                  </div>
                  <div>
                    <dt>国家或地区</dt>
                    <dd>{selected.recipient.country}</dd>
                  </div>
                  <div className="wide">
                    <dt>收件地址</dt>
                    <dd>{selected.recipient.address}</dd>
                  </div>
                  <div>
                    <dt>寄送费用</dt>
                    <dd>
                      {selected.shipping_currency} {selected.shipping_fee}
                    </dd>
                  </div>
                  <div>
                    <dt>物流</dt>
                    <dd>
                      {selected.shipment
                        ? `${selected.shipment.carrier} · ${selected.shipment.tracking_number}`
                        : '-'}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="ops-section">
                <h3>冻结明细</h3>
                <div className="ops-table-wrap">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>产品</th>
                        <th>样品数</th>
                        <th>转单上限</th>
                        <th>销售价</th>
                        <th>毛利状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.line_no}</td>
                          <td>{item.description}</td>
                          <td>
                            {item.sample_quantity} {item.unit}
                          </td>
                          <td>{item.maximum_conversion_quantity}</td>
                          <td>
                            {item.sales_currency} {item.sales_unit_price}
                          </td>
                          <td>{item.margin_status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {(selected.approval ||
                selected.delivery ||
                selected.feedback ||
                selected.conversion ||
                selected.closure) && (
                <section className="ops-section">
                  <h3>状态事实</h3>
                  <div className="ops-timeline">
                    {selected.approval && (
                      <div>
                        <strong>
                          审批{' '}
                          {
                            statusLabel[
                              selected.approval.decision === 'approved' ? 'approved' : 'rejected'
                            ]
                          }
                        </strong>
                        <span>
                          {selected.approval.reason || '无备注'} ·{' '}
                          {dateTime(selected.approval.created_at)}
                        </span>
                      </div>
                    )}
                    {selected.delivery && (
                      <div>
                        <strong>客户签收</strong>
                        <span>
                          {selected.delivery.received_by} ·{' '}
                          {dateTime(selected.delivery.delivered_at)}
                        </span>
                      </div>
                    )}
                    {selected.feedback && (
                      <div>
                        <strong>客户反馈</strong>
                        <span>
                          {selected.feedback.feedback} · {dateTime(selected.feedback.confirmed_at)}
                        </span>
                      </div>
                    )}
                    {selected.conversion && (
                      <div>
                        <strong>正式订单</strong>
                        <span>
                          {selected.conversion.sales_order_id} ·{' '}
                          {dateTime(selected.conversion.created_at)}
                        </span>
                      </div>
                    )}
                    {selected.closure && (
                      <div>
                        <strong>关闭</strong>
                        <span>
                          {selected.closure.reason} · {dateTime(selected.closure.created_at)}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              <section className="ops-section ops-operation">
                <h3>当前操作</h3>
                {selected.status === 'draft' && hasPermission('sample_orders:create') && (
                  <div className="ops-actions">
                    <button
                      className="ops-button"
                      disabled={busy}
                      onClick={() => void run(() => apiClient.submitSampleOrder(selected.id))}
                    >
                      提交审批
                    </button>
                  </div>
                )}
                {selected.status === 'pending_approval' &&
                  hasPermission('sample_orders:approve') && (
                    <>
                      <label className="ops-field">
                        审批原因
                        <input
                          maxLength={1000}
                          value={decisionReason}
                          onChange={(event) => setDecisionReason(event.target.value)}
                        />
                      </label>
                      <div className="ops-actions">
                        <button
                          className="ops-button"
                          disabled={busy}
                          onClick={() => decide('approved')}
                        >
                          批准
                        </button>
                        <button
                          className="ops-button danger"
                          disabled={busy}
                          onClick={() => decide('rejected')}
                        >
                          拒绝
                        </button>
                      </div>
                    </>
                  )}
                {selected.status === 'approved' && hasPermission('sample_orders:fulfill') && (
                  <form className="ops-form-grid three" onSubmit={dispatch}>
                    <label className="ops-field">
                      承运商
                      <input
                        required
                        value={carrier}
                        onChange={(event) => setCarrier(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      运单号
                      <input
                        required
                        value={trackingNumber}
                        onChange={(event) => setTrackingNumber(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      寄出时间
                      <input
                        required
                        type="datetime-local"
                        value={dispatchedAt}
                        onChange={(event) => setDispatchedAt(event.target.value)}
                      />
                    </label>
                    <div className="ops-actions wide">
                      <button className="ops-button" disabled={busy}>
                        确认寄出
                      </button>
                    </div>
                  </form>
                )}
                {selected.status === 'dispatched' && hasPermission('sample_orders:fulfill') && (
                  <form className="ops-form-grid two" onSubmit={deliver}>
                    <label className="ops-field">
                      签收人
                      <input
                        required
                        value={receivedBy}
                        onChange={(event) => setReceivedBy(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      签收时间
                      <input
                        required
                        type="datetime-local"
                        value={deliveredAt}
                        onChange={(event) => setDeliveredAt(event.target.value)}
                      />
                    </label>
                    <div className="ops-actions wide">
                      <button className="ops-button" disabled={busy}>
                        确认送达
                      </button>
                    </div>
                  </form>
                )}
                {selected.status === 'delivered' && hasPermission('sample_orders:create') && (
                  <>
                    <label className="ops-field">
                      客户反馈
                      <textarea
                        required
                        value={feedback}
                        onChange={(event) => setFeedback(event.target.value)}
                      />
                    </label>
                    <div className="ops-actions">
                      <button
                        className="ops-button"
                        disabled={busy || !feedback.trim()}
                        onClick={() =>
                          void run(() => apiClient.confirmSampleOrder(selected.id, feedback))
                        }
                      >
                        确认客户反馈
                      </button>
                    </div>
                  </>
                )}
                {selected.status === 'confirmed' && hasPermission('sample_orders:convert') && (
                  <form onSubmit={convert}>
                    <label className="ops-field">
                      付款条款
                      <textarea
                        required
                        value={paymentTerms}
                        onChange={(event) => setPaymentTerms(event.target.value)}
                      />
                    </label>
                    <div className="ops-table-wrap">
                      <table className="ops-table">
                        <thead>
                          <tr>
                            <th>产品</th>
                            <th>转正式订单数量</th>
                            <th>上限</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.description}</td>
                              <td>
                                <input
                                  required
                                  aria-label={`${item.description}转正式订单数量`}
                                  value={conversionQuantities[item.id] ?? ''}
                                  onChange={(event) =>
                                    setConversionQuantities((current) => ({
                                      ...current,
                                      [item.id]: event.target.value,
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                {item.maximum_conversion_quantity} {item.unit}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="ops-actions">
                      <button className="ops-button" disabled={busy}>
                        生成正式订单
                      </button>
                    </div>
                  </form>
                )}
                {['approved', 'dispatched', 'delivered', 'confirmed'].includes(selected.status) &&
                  hasPermission('sample_orders:create') && (
                    <div className="ops-close-row">
                      <label className="ops-field">
                        关闭原因
                        <input
                          value={closeReason}
                          onChange={(event) => setCloseReason(event.target.value)}
                        />
                      </label>
                      <button
                        className="ops-button secondary"
                        type="button"
                        disabled={busy || !closeReason.trim()}
                        onClick={() =>
                          void run(() => apiClient.closeSampleOrder(selected.id, closeReason))
                        }
                      >
                        关闭样品单
                      </button>
                    </div>
                  )}
                {['rejected', 'converted', 'closed'].includes(selected.status) && (
                  <p className="ops-muted">该样品单没有待执行操作。</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

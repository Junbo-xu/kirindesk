import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import { saveBlob } from '../lib/download';
import {
  ApiError,
  CommercialSelection,
  CommercialSettings,
  Currency,
  CustomerReceipt,
  InquirySummary,
  ProcurementGate,
  ProformaInvoice,
  SalesQuotation,
} from '../lib/types';

const card = {
  background: 'white',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '操作失败，请稍后重试';
}

function marginPercent(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const absolute = Math.abs(bps);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}%`;
}

function ReceiptPanel({ orderId, currency }: { orderId: string; currency: Currency }) {
  const { hasPermission } = useAuth();
  const [receipts, setReceipts] = useState<CustomerReceipt[]>([]);
  const [gate, setGate] = useState<ProcurementGate | null>(null);
  const [amount, setAmount] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<CustomerReceipt['method']>('bank_transfer');
  const [reference, setReference] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const [receiptRows, gateState] = await Promise.all([
      apiClient.listCustomerReceipts(orderId),
      apiClient.getProcurementGate(orderId),
    ]);
    setReceipts(receiptRows);
    setGate(gateState);
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorMessage(err)));
  }, [orderId]);

  async function record(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const uploaded = proof ? await apiClient.uploadFile(proof, 'receipt_proof') : null;
      await apiClient.recordCustomerReceipt(orderId, {
        amount,
        currency,
        received_at: receivedAt,
        method,
        external_reference: reference,
        proof_file_id: uploaded?.id,
      });
      setAmount('');
      setReference('');
      setProof(null);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function review(receipt: CustomerReceipt, decision: 'confirmed' | 'rejected') {
    setBusy(true);
    setError(null);
    try {
      await apiClient.reviewCustomerReceipt(receipt.id, decision, reasons[receipt.id] || undefined);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #e2e8f0' }}>
      <h4 style={{ margin: '0 0 10px' }}>收款流水与采购闸门</h4>
      {gate && (
        <div data-testid="procurement-gate" style={{ marginBottom: 12 }}>
          <strong>
            闸门：
            {gate.status === 'open' ? '已开启' : gate.status === 'bypassed' ? '已旁路' : '已阻断'}
          </strong>
          <div style={{ color: '#475569', marginTop: 4 }}>
            已确认 {gate.currency} {gate.confirmed_amount} / 要求 {gate.required_amount}
            {gate.blocking_reasons.length > 0 ? ` · ${gate.blocking_reasons.join('、')}` : ''}
          </div>
          {gate.bypass_reason && (
            <div style={{ color: '#9a3412' }}>旁路原因：{gate.bypass_reason}</div>
          )}
        </div>
      )}
      {hasPermission('customer_receipts:record') && (
        <form
          onSubmit={record}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}
        >
          <label>
            金额 ({currency})
            <input
              aria-label="收款金额"
              required
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label>
            到款日期
            <input
              aria-label="到款日期"
              type="date"
              required
              value={receivedAt}
              onChange={(event) => setReceivedAt(event.target.value)}
            />
          </label>
          <label>
            外部流水号
            <input
              aria-label="外部流水号"
              required
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <label>
            到款方式
            <select
              aria-label="到款方式"
              value={method}
              onChange={(event) => setMethod(event.target.value as CustomerReceipt['method'])}
            >
              <option value="bank_transfer">银行转账</option>
              <option value="cash">现金</option>
              <option value="card_external">外部刷卡</option>
              <option value="other_external">其他外部渠道</option>
            </select>
          </label>
          <label style={{ gridColumn: 'span 2' }}>
            收款凭证
            <input
              aria-label="收款凭证"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              onChange={(event) => setProof(event.target.files?.[0] ?? null)}
            />
          </label>
          <button type="submit" disabled={busy} style={{ width: 'fit-content' }}>
            {busy ? '处理中…' : '记录外部到款事实'}
          </button>
        </form>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <table style={{ width: '100%', marginTop: 14, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>日期</th>
            <th>金额</th>
            <th>外部流水号</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => (
            <tr key={receipt.id}>
              <td>{receipt.received_at}</td>
              <td>
                {receipt.currency} {receipt.amount}
              </td>
              <td>{receipt.external_reference}</td>
              <td>
                {receipt.status === 'recorded'
                  ? '待内部核对'
                  : receipt.status === 'confirmed'
                    ? '内部已确认'
                    : '已驳回'}
              </td>
              <td>
                {receipt.status === 'recorded' && hasPermission('customer_receipts:review') ? (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input
                      aria-label={`核对原因 ${receipt.external_reference}`}
                      placeholder="驳回时必填原因"
                      value={reasons[receipt.id] ?? ''}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [receipt.id]: event.target.value }))
                      }
                    />
                    <button disabled={busy} onClick={() => void review(receipt, 'confirmed')}>
                      确认
                    </button>
                    <button disabled={busy} onClick={() => void review(receipt, 'rejected')}>
                      驳回
                    </button>
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: '#64748b', fontSize: 12 }}>
        “内部已确认”仅代表 KirinDesk 人工核对，不代表第三方支付渠道回调或自动对账。
      </p>
    </section>
  );
}

export function CommercialFlowPage() {
  const { hasPermission } = useAuth();
  const [inquiries, setInquiries] = useState<InquirySummary[]>([]);
  const [inquiryId, setInquiryId] = useState('');
  const [quotations, setQuotations] = useState<SalesQuotation[]>([]);
  const [selections, setSelections] = useState<CommercialSelection[]>([]);
  const [pis, setPis] = useState<ProformaInvoice[]>([]);
  const [customers, setCustomers] = useState<Array<{ id: string; company_name: string }>>([]);
  const [settings, setSettings] = useState<CommercialSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<CommercialSettings | null>(null);
  const [selectionDrafts, setSelectionDrafts] = useState<
    Record<string, { price: string; currency: Currency; fx: string }>
  >({});
  const [selectedForPi, setSelectedForPi] = useState<string[]>([]);
  const [paymentTerms, setPaymentTerms] = useState('30% deposit, balance before shipment');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [linkCustomerId, setLinkCustomerId] = useState('');
  const [duplicateCandidates, setDuplicateCandidates] = useState<
    Array<{ id: string; company_name: string }>
  >([]);
  const [marginReasons, setMarginReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inquiry = inquiries.find((row) => row.id === inquiryId) ?? null;
  const allocatedSelections = useMemo(
    () => new Set(pis.flatMap((pi) => pi.items.map((item) => item.selection_id))),
    [pis],
  );

  async function loadInquiry(id: string) {
    const [quoteRows, selectionRows, piRows] = await Promise.all([
      apiClient.listSalesQuotations(id),
      apiClient.listSelections(id),
      apiClient.listProformaInvoices(id),
    ]);
    setQuotations(quoteRows);
    setSelections(selectionRows);
    setPis(piRows);
    setSelectedForPi(
      selectionRows
        .filter(
          (selection) =>
            !piRows.some((pi) => pi.items.some((item) => item.selection_id === selection.id)),
        )
        .map((selection) => selection.id),
    );
  }

  async function reloadAll(preferredId = inquiryId) {
    const rows = await apiClient.listInquiries();
    setInquiries(rows);
    const nextId = preferredId || rows[0]?.id || '';
    setInquiryId(nextId);
    if (nextId) await loadInquiry(nextId);
  }

  useEffect(() => {
    Promise.all([
      reloadAll(),
      apiClient.listCustomers({ pageSize: 100 }).then((result) => setCustomers(result.data)),
      hasPermission('tenant_settings:view')
        ? apiClient.getCommercialSettings().then((value) => {
            setSettings(value);
            setDraftSettings(value);
          })
        : Promise.resolve(),
    ]).catch((err) => setError(errorMessage(err)));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reloadAll(inquiryId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function upgradeCustomer(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDuplicateCandidates([]);
    try {
      await apiClient.upgradeInquiryCustomer(inquiryId, {
        company_name: newCustomerName,
        email: newCustomerEmail || undefined,
        country: inquiry?.customer_country,
      });
      await reloadAll(inquiryId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_CUSTOMER') {
        const candidates = err.details?.candidates;
        if (Array.isArray(candidates)) {
          setDuplicateCandidates(candidates as Array<{ id: string; company_name: string }>);
        }
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function chooseQuotation(quotation: SalesQuotation, lineId: string) {
    const draft = selectionDrafts[lineId] ?? { price: '', currency: quotation.currency, fx: '' };
    await run(async () => {
      await apiClient.selectQuotation(inquiryId, {
        quotation_line_id: lineId,
        expected_quotation_version: quotation.version,
        sales_currency: draft.currency,
        sales_unit_price: draft.price,
        purchase_to_sales_fx_rate: draft.currency === quotation.currency ? undefined : draft.fx,
      });
    });
  }

  async function exportPi(pi: ProformaInvoice) {
    setBusy(true);
    setError(null);
    try {
      const file = await apiClient.exportProformaInvoice(pi.id);
      saveBlob(file.blob, file.filename);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!draftSettings) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await apiClient.updateCommercialSettings(draftSettings);
      setSettings(updated);
      setDraftSettings(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ maxWidth: 1180 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>选价、PI 与收款闸门</h1>
      <p style={{ color: '#64748b' }}>
        采购价、销售价、汇率和毛利均读取冻结快照；到款记录不代表第三方支付成功。
      </p>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}

      {draftSettings && hasPermission('tenant_settings:update') && (
        <form onSubmit={saveSettings} style={card}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>商业规则</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label>
              最低毛利基点{' '}
              <input
                aria-label="最低毛利基点"
                type="number"
                value={draftSettings.minimum_margin_bps}
                onChange={(event) =>
                  setDraftSettings({
                    ...draftSettings,
                    minimum_margin_bps: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              到款比例基点{' '}
              <input
                aria-label="到款比例基点"
                type="number"
                min="0"
                max="10000"
                value={draftSettings.required_receipt_ratio_bps}
                onChange={(event) =>
                  setDraftSettings({
                    ...draftSettings,
                    required_receipt_ratio_bps: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={draftSettings.receipt_proof_required}
                onChange={(event) =>
                  setDraftSettings({
                    ...draftSettings,
                    receipt_proof_required: event.target.checked,
                  })
                }
              />{' '}
              必须上传凭证
            </label>
            <label>
              <input
                type="checkbox"
                checked={draftSettings.procurement_gate_enabled}
                onChange={(event) =>
                  setDraftSettings({
                    ...draftSettings,
                    procurement_gate_enabled: event.target.checked,
                    bypass_reason: event.target.checked ? null : draftSettings.bypass_reason,
                  })
                }
              />{' '}
              启用采购闸门
            </label>
            {!draftSettings.procurement_gate_enabled && (
              <input
                aria-label="闸门旁路原因"
                placeholder="关闭闸门必须填写原因"
                value={draftSettings.bypass_reason ?? ''}
                onChange={(event) =>
                  setDraftSettings({ ...draftSettings, bypass_reason: event.target.value })
                }
              />
            )}
            <button disabled={busy} type="submit">
              保存规则
            </button>
          </div>
          {settings && (
            <small style={{ color: '#64748b' }}>
              当前要求：毛利 {marginPercent(settings.minimum_margin_bps)}，确认到款{' '}
              {marginPercent(settings.required_receipt_ratio_bps)}
            </small>
          )}
        </form>
      )}

      <div style={card}>
        <label>
          当前询盘
          <select
            aria-label="当前询盘"
            value={inquiryId}
            onChange={(event) => {
              setInquiryId(event.target.value);
              void loadInquiry(event.target.value).catch((err) => setError(errorMessage(err)));
            }}
          >
            {inquiries.map((row) => (
              <option key={row.id} value={row.id}>
                {row.customer_code} · {row.status}
              </option>
            ))}
          </select>
        </label>
      </div>

      {inquiry && !inquiry.customer_id && (
        <div style={card}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>线索升级为正式客户</h2>
          <form onSubmit={upgradeCustomer} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              aria-label="客户公司名"
              required
              placeholder="公司名"
              value={newCustomerName}
              onChange={(event) => setNewCustomerName(event.target.value)}
            />
            <input
              aria-label="客户邮箱"
              type="email"
              placeholder="邮箱（用于重复识别）"
              value={newCustomerEmail}
              onChange={(event) => setNewCustomerEmail(event.target.value)}
            />
            <button disabled={busy}>创建并关联</button>
          </form>
          <div style={{ marginTop: 10 }}>
            <select
              aria-label="关联已有客户"
              value={linkCustomerId}
              onChange={(event) => setLinkCustomerId(event.target.value)}
            >
              <option value="">选择已有客户</option>
              {[...duplicateCandidates, ...customers]
                .filter(
                  (item, index, rows) => rows.findIndex((row) => row.id === item.id) === index,
                )
                .map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.company_name}
                  </option>
                ))}
            </select>{' '}
            <button
              disabled={!linkCustomerId || busy}
              onClick={() =>
                void run(() => apiClient.linkInquiryCustomer(inquiryId, linkCustomerId))
              }
            >
              关联已有客户
            </button>
          </div>
        </div>
      )}

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>选价与精确毛利</h2>
        {quotations
          .flatMap((quotation) => quotation.lines.map((line) => ({ quotation, line })))
          .map(({ quotation, line }) => {
            const alreadySelected = selections.some(
              (selection) => selection.inquiry_item_id === line.inquiry_item_id,
            );
            const draft = selectionDrafts[line.id] ?? {
              price: '',
              currency: quotation.currency,
              fx: '',
            };
            return (
              <div key={line.id} style={{ borderTop: '1px solid #e2e8f0', padding: '10px 0' }}>
                <strong>
                  采购价 {quotation.currency} {line.unit_price}
                </strong>{' '}
                · 有效至 {quotation.valid_until}
                {alreadySelected ? (
                  <span style={{ marginLeft: 12, color: '#166534' }}>已冻结选价</span>
                ) : (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <input
                      aria-label={`销售单价 ${line.id}`}
                      placeholder="销售单价"
                      value={draft.price}
                      onChange={(event) =>
                        setSelectionDrafts((current) => ({
                          ...current,
                          [line.id]: { ...draft, price: event.target.value },
                        }))
                      }
                    />
                    <select
                      aria-label={`销售币种 ${line.id}`}
                      value={draft.currency}
                      onChange={(event) =>
                        setSelectionDrafts((current) => ({
                          ...current,
                          [line.id]: { ...draft, currency: event.target.value as Currency },
                        }))
                      }
                    >
                      {(['RMB', 'USD', 'HKD', 'EUR'] as Currency[]).map((currency) => (
                        <option key={currency}>{currency}</option>
                      ))}
                    </select>
                    {draft.currency !== quotation.currency && (
                      <input
                        aria-label={`采购销售汇率 ${line.id}`}
                        placeholder="采购币种→销售币种汇率"
                        value={draft.fx}
                        onChange={(event) =>
                          setSelectionDrafts((current) => ({
                            ...current,
                            [line.id]: { ...draft, fx: event.target.value },
                          }))
                        }
                      />
                    )}
                    <button
                      disabled={!draft.price || busy}
                      onClick={() => void chooseQuotation(quotation, line.id)}
                    >
                      冻结选价
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        {selections.map((selection) => (
          <div
            key={selection.id}
            data-testid="commercial-selection"
            style={{ borderTop: '1px solid #e2e8f0', padding: '10px 0' }}
          >
            <strong>{selection.snapshot.inquiry_item.description}</strong> · 销售价{' '}
            {selection.commercial?.sales_currency} {selection.commercial?.sales_unit_price} · 成本{' '}
            {selection.commercial?.purchase_unit_cost} · 毛利{' '}
            {selection.commercial
              ? marginPercent(selection.commercial.gross_margin_bps)
              : '旧版快照待补'}
            {selection.commercial?.margin_status === 'below_threshold' && (
              <div style={{ color: '#b45309', marginTop: 6 }}>
                低于阈值 {marginPercent(selection.commercial.margin_threshold_bps)}
                {selection.commercial.margin_approved ? (
                  ' · 已审计放行'
                ) : hasPermission('quote_selections:approve_margin') ? (
                  <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8 }}>
                    <input
                      aria-label={`低毛利放行原因 ${selection.id}`}
                      placeholder="放行原因"
                      value={marginReasons[selection.id] ?? ''}
                      onChange={(event) =>
                        setMarginReasons((current) => ({
                          ...current,
                          [selection.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      disabled={!marginReasons[selection.id] || busy}
                      onClick={() =>
                        void run(() =>
                          apiClient.approveSelectionMargin(
                            selection.id,
                            marginReasons[selection.id],
                          ),
                        )
                      }
                    >
                      放行
                    </button>
                  </span>
                ) : (
                  ' · PI 签发前需管理员放行'
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>PI 版本与客户确认</h2>
        {inquiry?.customer_id &&
          hasPermission('proforma_invoices:create') &&
          selections.some((selection) => !allocatedSelections.has(selection.id)) && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  apiClient.createProformaInvoice(inquiryId, selectedForPi, paymentTerms),
                );
              }}
              style={{ marginBottom: 16 }}
            >
              {selections
                .filter((selection) => !allocatedSelections.has(selection.id))
                .map((selection) => (
                  <label key={selection.id} style={{ display: 'block' }}>
                    <input
                      type="checkbox"
                      checked={selectedForPi.includes(selection.id)}
                      onChange={(event) =>
                        setSelectedForPi((current) =>
                          event.target.checked
                            ? [...current, selection.id]
                            : current.filter((id) => id !== selection.id),
                        )
                      }
                    />{' '}
                    {selection.snapshot.inquiry_item.description}
                  </label>
                ))}
              <textarea
                aria-label="PI 付款条款"
                required
                value={paymentTerms}
                onChange={(event) => setPaymentTerms(event.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              />
              <button disabled={selectedForPi.length === 0 || busy}>创建 PI 草稿</button>
            </form>
          )}
        {pis.map((pi) => (
          <article
            key={pi.id}
            data-testid="proforma-invoice"
            style={{ borderTop: '1px solid #e2e8f0', padding: '12px 0' }}
          >
            <div>
              <strong>
                {pi.pi_number} v{pi.version}
              </strong>{' '}
              · {pi.status} · {pi.currency} {pi.total_amount}{' '}
              {pi.is_current === false ? '· 已被新版取代' : ''}
            </div>
            <div style={{ color: '#64748b', margin: '4px 0 8px' }}>{pi.payment_terms}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {pi.status === 'draft' &&
                pi.is_current !== false &&
                hasPermission('proforma_invoices:issue') && (
                  <button
                    disabled={busy}
                    onClick={() => void run(() => apiClient.issueProformaInvoice(pi.id))}
                  >
                    签发 PI
                  </button>
                )}
              {pi.status !== 'customer_confirmed' &&
                pi.is_current !== false &&
                hasPermission('proforma_invoices:create') && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      const terms = window.prompt('新版本付款条款', pi.payment_terms);
                      if (terms) void run(() => apiClient.reviseProformaInvoice(pi.id, terms));
                    }}
                  >
                    创建修订版
                  </button>
                )}
              {pi.status === 'issued' &&
                pi.is_current !== false &&
                hasPermission('proforma_invoices:confirm') && (
                  <button
                    disabled={busy}
                    onClick={() => void run(() => apiClient.confirmProformaInvoice(pi.id))}
                  >
                    记录客户确认
                  </button>
                )}
              {hasPermission('proforma_invoices:export') && (
                <button disabled={busy} onClick={() => void exportPi(pi)}>
                  导出水印 PI
                </button>
              )}
            </div>
            {pi.sales_order_id && hasPermission('customer_receipts:view') && (
              <ReceiptPanel orderId={pi.sales_order_id} currency={pi.currency} />
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

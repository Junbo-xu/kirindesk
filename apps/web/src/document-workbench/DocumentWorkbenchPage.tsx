import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CustomerResponse,
  ProductFieldRecord,
  ProductRecord,
  SalesOrderResponse,
  TradeDocumentExport,
  TradeDocumentInput,
  TradeDocumentLanguage,
  TradeDocumentLineInput,
  TradeDocumentLink,
  TradeDocumentSet,
  TradeDocumentType,
} from '../lib/types';

const DOCUMENT_TYPES: Array<{ type: TradeDocumentType; label: string }> = [
  { type: 'quote', label: '报价单 QT' },
  { type: 'pi', label: '形式发票 PI' },
  { type: 'sc', label: '销售合同 SC' },
  { type: 'ci', label: '商业发票 CI' },
  { type: 'pl', label: '装箱单 PL' },
];

const LANGUAGES: Array<{ value: TradeDocumentLanguage; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ar', label: 'العربية' },
];

function emptyLine(): TradeDocumentLineInput {
  return { sku: '', name: '', quantity: '1', unit: 'pcs', unit_price: '0' };
}

function emptyDocument(): TradeDocumentInput {
  const now = new Date();
  return {
    quote_number: `QT-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(now.getTime()).slice(-5)}`,
    pricing_mode: 'final_price',
    language: 'en',
    incoterm: 'FOB',
    pricing_currency: 'USD',
    settlement_currency: 'USD',
    exchange_rate: '1',
    discount_type: 'none',
    discount_value: '0',
    freight_amount: '0',
    insurance_amount: '0',
    tax_amount: '0',
    internal_expenses: '0',
    allocation_method: 'value',
    packing_mode: 'normal',
    theme_color: '#155EEF',
    visible_fields: { thumbnail: true, terms: true, bank_info: true, signature: true },
    lines: [emptyLine()],
  };
}

function inputFromDocument(document: TradeDocumentSet): TradeDocumentInput {
  return {
    customer_id: document.customer?.id,
    sales_order_id: document.sales_order_id ?? undefined,
    quote_number: document.quote_number,
    pricing_mode: document.pricing_mode ?? 'final_price',
    language: document.language,
    incoterm: document.incoterm,
    pricing_currency: document.pricing_currency,
    settlement_currency: document.settlement_currency,
    exchange_rate: document.exchange_rate,
    discount_type: document.discount_type,
    discount_value: document.discount_value,
    freight_amount: document.totals.freight_amount,
    insurance_amount: document.totals.insurance_amount,
    tax_amount: document.totals.tax_amount,
    internal_expenses: document.internal_expenses ?? '0',
    allocation_method: document.allocation_method,
    packing_mode: document.packing_mode,
    theme_color: document.theme_color,
    visible_fields: document.visible_fields,
    terms: document.terms ?? undefined,
    bank_info: document.bank_info ?? undefined,
    logo_file_id: document.logo_file_id ?? undefined,
    signature_file_id: document.signature_file_id ?? undefined,
    lines: document.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      description: line.description ?? undefined,
      quantity: line.quantity,
      unit: line.unit,
      unit_price: line.unit_price,
      cost_unit_price: line.cost_unit_price ?? undefined,
      weight_kg: line.weight_kg ?? undefined,
      volume_cbm: line.volume_cbm ?? undefined,
      package_no: line.package_no ?? undefined,
      thumbnail_file_id: line.thumbnail_file_id ?? undefined,
      custom_values: Object.fromEntries(
        line.custom_fields.map((field) => [field.field_key, field.value]),
      ),
    })),
  };
}

function cleanDocument(input: TradeDocumentInput): TradeDocumentInput {
  const optional = (value: string | undefined) => value?.trim() || undefined;
  return {
    ...input,
    customer_id: input.customer_id || undefined,
    sales_order_id: input.sales_order_id || undefined,
    terms: optional(input.terms),
    bank_info: optional(input.bank_info),
    logo_file_id: input.logo_file_id || undefined,
    signature_file_id: input.signature_file_id || undefined,
    lines: input.lines.map((line) => ({
      ...line,
      product_id: line.product_id || undefined,
      description: optional(line.description),
      cost_unit_price: optional(line.cost_unit_price),
      weight_kg: optional(line.weight_kg),
      volume_cbm: optional(line.volume_cbm),
      package_no: optional(line.package_no),
      thumbnail_file_id: line.thumbnail_file_id || undefined,
    })),
  };
}

export function DocumentWorkbenchPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('document_sets:manage');
  const canLock = hasPermission('document_sets:lock');
  const canExport = hasPermission('document_sets:export');
  const canShare = hasPermission('document_links:manage');
  const canSeeFinancials = hasPermission('document_financials:view');
  const [documents, setDocuments] = useState<TradeDocumentSet[]>([]);
  const [customers, setCustomers] = useState<CustomerResponse[]>([]);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [customFields, setCustomFields] = useState<ProductFieldRecord[]>([]);
  const [orders, setOrders] = useState<SalesOrderResponse[]>([]);
  const [exports, setExports] = useState<TradeDocumentExport[]>([]);
  const [links, setLinks] = useState<TradeDocumentLink[]>([]);
  const [selected, setSelected] = useState<TradeDocumentSet | null>(null);
  const [draft, setDraft] = useState<TradeDocumentInput>(emptyDocument());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedId = selected?.document_set_id ?? null;
  const locked = selected?.status === 'locked';
  const grossMargin = useMemo(() => {
    const bps = selected?.internal_totals?.gross_margin_bps;
    return bps === null || bps === undefined ? '-' : `${(bps / 100).toFixed(2)}%`;
  }, [selected]);

  async function loadBase() {
    setLoading(true);
    setError(null);
    try {
      const [documentResult, productResult, fieldResult, customerResult, orderResult] =
        await Promise.all([
          apiClient.listDocumentSets({ pageSize: 100 }),
          apiClient.listProducts({ active: true, pageSize: 100 }),
          apiClient.listProductFields(),
          apiClient.listCustomers({ status: 'active', pageSize: 100 }),
          apiClient.listSalesOrders({ pageSize: 100 }),
        ]);
      setDocuments(documentResult.data);
      setProducts(productResult.data);
      setCustomFields(fieldResult.custom.filter((field) => field.active));
      setCustomers(customerResult.data);
      setOrders(orderResult.data);
      if (selectedId) {
        const refreshed = documentResult.data.find(
          (document) => document.document_set_id === selectedId,
        );
        if (refreshed) {
          setSelected(refreshed);
          setDraft(inputFromDocument(refreshed));
        }
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '加载单证工作台失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBase();
  }, []);

  async function loadArtifacts(documentId: string) {
    const [exportRows, linkRows] = await Promise.all([
      apiClient.listDocumentExports(documentId),
      canShare ? apiClient.listDocumentLinks(documentId) : Promise.resolve([]),
    ]);
    setExports(exportRows);
    setLinks(linkRows);
  }

  async function selectDocument(document: TradeDocumentSet) {
    setError(null);
    try {
      const detail = await apiClient.getDocumentSet(document.document_set_id);
      setSelected(detail);
      setDraft(inputFromDocument(detail));
      await loadArtifacts(detail.document_set_id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '加载单证失败');
    }
  }

  function startNew() {
    setSelected(null);
    setDraft(emptyDocument());
    setExports([]);
    setLinks([]);
    setError(null);
    setNotice(null);
  }

  function updateLine(index: number, patch: Partial<TradeDocumentLineInput>) {
    setDraft({
      ...draft,
      lines: draft.lines.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...patch } : line,
      ),
    });
  }

  function updateCustomValue(index: number, field: ProductFieldRecord, value: unknown) {
    const currentValues = draft.lines[index].custom_values ?? {};
    updateLine(index, { custom_values: { ...currentValues, [field.field_key]: value } });
  }

  function chooseProduct(index: number, productId: string) {
    const product = products.find((record) => record.id === productId);
    if (!product) {
      updateLine(index, { product_id: undefined });
      return;
    }
    updateLine(index, {
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description ?? undefined,
      unit: product.unit,
      unit_price: product.default_unit_price,
      cost_unit_price: product.cost_unit_price ?? undefined,
      weight_kg: product.weight_kg ?? undefined,
      volume_cbm: product.volume_cbm ?? undefined,
      thumbnail_file_id: product.thumbnail_file_id ?? undefined,
      custom_values: product.custom_values,
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = cleanDocument(draft);
      const saved = selected
        ? await apiClient.updateDocumentSet(selected.document_set_id, {
            ...payload,
            expected_version: selected.source_version,
          })
        : await apiClient.createDocumentSet(payload);
      setSelected(saved);
      setDraft(inputFromDocument(saved));
      await loadBase();
      await loadArtifacts(saved.document_set_id);
      setNotice(`已保存 ${saved.quote_number} v${saved.source_version}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存单证失败');
    } finally {
      setSaving(false);
    }
  }

  async function lockDocument() {
    if (!selected || !window.confirm('锁定后本版本及所有行项目不可再修改，确认锁定？')) return;
    setSaving(true);
    setError(null);
    try {
      const result = await apiClient.lockDocumentSet(selected.document_set_id);
      setSelected(result);
      setDraft(inputFromDocument(result));
      await loadBase();
      setNotice('单证已锁定为不可变快照');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '锁定失败');
    } finally {
      setSaving(false);
    }
  }

  async function exportPdf(type: TradeDocumentType) {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const exported = await apiClient.exportDocumentSet(selected.document_set_id, type);
      await loadArtifacts(selected.document_set_id);
      const url = await apiClient.getFileDownloadUrl(exported.file_id);
      window.location.assign(url);
      setNotice(`${type.toUpperCase()} PDF 已归档到 Files 并开始下载`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'PDF 导出失败');
    } finally {
      setSaving(false);
    }
  }

  async function createLink(exported: TradeDocumentExport) {
    setSaving(true);
    setError(null);
    try {
      const result = await apiClient.createDocumentLink(exported.id);
      const url = `${window.location.origin}${result.path}`;
      await navigator.clipboard.writeText(url).catch(() => undefined);
      await loadArtifacts(exported.document_set_id);
      setNotice(`客户追踪链接已创建并复制：${url}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '创建追踪链接失败');
    } finally {
      setSaving(false);
    }
  }

  async function revokeLink(link: TradeDocumentLink) {
    if (!window.confirm('作废后客户将无法继续打开或下载此固定版本，确认？')) return;
    setError(null);
    try {
      await apiClient.revokeDocumentLink(link.id);
      if (selected) await loadArtifacts(selected.document_set_id);
      setNotice('追踪链接已作废');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '作废链接失败');
    }
  }

  async function uploadBrandAsset(kind: 'logo_file_id' | 'signature_file_id', file?: File) {
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      const uploaded = await apiClient.uploadFile(
        file,
        kind === 'logo_file_id' ? 'document-logo' : 'document-signature',
      );
      setDraft({ ...draft, [kind]: uploaded.id });
      setNotice('图片已上传到 Files，保存单证后生效');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '上传图片失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px minmax(0, 1fr)',
        gap: 22,
        alignItems: 'start',
      }}
    >
      <aside
        style={{
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: 10,
          padding: 14,
          position: 'sticky',
          top: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>外贸单证</h1>
          {canManage && (
            <button type="button" onClick={startNew}>
              新建
            </button>
          )}
        </div>
        <p style={{ color: '#64748b', fontSize: 13 }}>一次录入，联动 QT / PI / SC / CI / PL</p>
        {loading ? (
          <p>加载中…</p>
        ) : documents.length === 0 ? (
          <p>暂无单证</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {documents.map((document) => (
              <button
                type="button"
                key={document.document_set_id}
                onClick={() => void selectDocument(document)}
                style={{
                  textAlign: 'left',
                  border:
                    selectedId === document.document_set_id
                      ? '2px solid #155eef'
                      : '1px solid #cbd5e1',
                  background: 'white',
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <strong>{document.quote_number}</strong>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  {document.customer?.company_name ?? '快速报价（未关联客户）'} · v
                  {document.source_version} · {document.status === 'locked' ? '已锁定' : '草稿'}
                </div>
                <div>
                  {document.pricing_currency} {document.totals.grand_total}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>
      <main style={{ minWidth: 0 }}>
        <header style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>
            {selected ? selected.quote_number : '新建快速报价'}
          </h1>
          <p style={{ color: '#64748b' }}>
            {selected
              ? `${selected.status === 'locked' ? '锁定快照' : '草稿联动'} · 版本 ${selected.source_version}`
              : '客户可暂不选择，保存后可补录'}
          </p>
        </header>
        {error && (
          <div
            role="alert"
            style={{ color: '#b42318', background: '#fef3f2', padding: 12, marginBottom: 12 }}
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            style={{
              color: '#067647',
              background: '#ecfdf3',
              padding: 12,
              marginBottom: 12,
              overflowWrap: 'anywhere',
            }}
          >
            {notice}
          </div>
        )}
        <form onSubmit={save} style={{ display: 'grid', gap: 18 }}>
          <section
            style={{
              background: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 18,
            }}
          >
            <h2 style={{ fontSize: 18, marginTop: 0 }}>报价与客户</h2>
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}
            >
              <label>
                单号
                <input
                  disabled={locked || !canManage}
                  required
                  value={draft.quote_number}
                  onChange={(event) => setDraft({ ...draft, quote_number: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                客户（可后补）
                <select
                  disabled={locked || !canManage}
                  value={draft.customer_id ?? ''}
                  onChange={(event) =>
                    setDraft({ ...draft, customer_id: event.target.value || undefined })
                  }
                  style={{ width: '100%' }}
                >
                  <option value="">未关联客户</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.company_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                销售订单（可选）
                <select
                  disabled={locked || !canManage}
                  value={draft.sales_order_id ?? ''}
                  onChange={(event) =>
                    setDraft({ ...draft, sales_order_id: event.target.value || undefined })
                  }
                  style={{ width: '100%' }}
                >
                  <option value="">未关联订单</option>
                  {orders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.order_number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                语言
                <select
                  disabled={locked || !canManage}
                  value={draft.language}
                  onChange={(event) =>
                    setDraft({ ...draft, language: event.target.value as TradeDocumentLanguage })
                  }
                  style={{ width: '100%' }}
                >
                  {LANGUAGES.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                贸易术语
                <select
                  disabled={locked || !canManage}
                  value={draft.incoterm}
                  onChange={(event) =>
                    setDraft({ ...draft, incoterm: event.target.value as 'FOB' | 'CIF' | 'EXW' })
                  }
                  style={{ width: '100%' }}
                >
                  <option>FOB</option>
                  <option>CIF</option>
                  <option>EXW</option>
                </select>
              </label>
              {canSeeFinancials && (
                <label>
                  报价模式
                  <select
                    disabled={locked || !canManage}
                    value={draft.pricing_mode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        pricing_mode: event.target.value as 'final_price' | 'cost_profit',
                      })
                    }
                    style={{ width: '100%' }}
                  >
                    <option value="final_price">最终报价</option>
                    <option value="cost_profit">成本利润</option>
                  </select>
                </label>
              )}
              <label>
                报价币种
                <input
                  disabled={locked || !canManage}
                  required
                  pattern="[A-Z]{3}"
                  value={draft.pricing_currency}
                  onChange={(event) =>
                    setDraft({ ...draft, pricing_currency: event.target.value.toUpperCase() })
                  }
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                结算币种
                <input
                  disabled={locked || !canManage}
                  required
                  pattern="[A-Z]{3}"
                  value={draft.settlement_currency}
                  onChange={(event) =>
                    setDraft({ ...draft, settlement_currency: event.target.value.toUpperCase() })
                  }
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                汇率
                <input
                  disabled={locked || !canManage}
                  required
                  value={draft.exchange_rate}
                  onChange={(event) => setDraft({ ...draft, exchange_rate: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
            </div>
          </section>
          <section
            style={{
              background: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 18,
              overflowX: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18, marginTop: 0 }}>产品明细</h2>
              {canManage && !locked && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, lines: [...draft.lines, emptyLine()] })}
                >
                  添加行
                </button>
              )}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>产品库</th>
                  <th>SKU</th>
                  <th>名称</th>
                  <th>数量</th>
                  <th>单位</th>
                  <th>售价</th>
                  {canSeeFinancials && <th>成本</th>}
                  <th>重量 kg</th>
                  <th>体积 CBM</th>
                  <th>箱号</th>
                  {customFields.map((field) => (
                    <th key={field.id}>{field.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line, index) => (
                  <tr key={index} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td>
                      <select
                        disabled={locked || !canManage}
                        value={line.product_id ?? ''}
                        onChange={(event) => chooseProduct(index, event.target.value)}
                      >
                        <option value="">手工录入</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.sku} · {product.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        disabled={locked || !canManage}
                        required
                        value={line.sku}
                        onChange={(event) => updateLine(index, { sku: event.target.value })}
                        style={{ width: 110 }}
                      />
                    </td>
                    {customFields.map((field) => (
                      <td key={field.id}>
                        {field.data_type === 'boolean' ? (
                          <input
                            type="checkbox"
                            disabled={locked || !canManage}
                            checked={Boolean(line.custom_values?.[field.field_key])}
                            onChange={(event) =>
                              updateCustomValue(index, field, event.target.checked)
                            }
                          />
                        ) : (
                          <input
                            type={
                              field.data_type === 'date'
                                ? 'date'
                                : field.data_type === 'number'
                                  ? 'number'
                                  : 'text'
                            }
                            step={field.data_type === 'number' ? 'any' : undefined}
                            disabled={locked || !canManage}
                            value={String(line.custom_values?.[field.field_key] ?? '')}
                            onChange={(event) =>
                              updateCustomValue(index, field, event.target.value)
                            }
                            style={{ width: 120 }}
                          />
                        )}
                      </td>
                    ))}
                    <td>
                      <input
                        disabled={locked || !canManage}
                        required
                        value={line.name}
                        onChange={(event) => updateLine(index, { name: event.target.value })}
                        style={{ width: 160 }}
                      />
                    </td>
                    <td>
                      <input
                        disabled={locked || !canManage}
                        required
                        value={line.quantity}
                        onChange={(event) => updateLine(index, { quantity: event.target.value })}
                        style={{ width: 75 }}
                      />
                    </td>
                    <td>
                      <input
                        disabled={locked || !canManage}
                        required
                        value={line.unit}
                        onChange={(event) => updateLine(index, { unit: event.target.value })}
                        style={{ width: 70 }}
                      />
                    </td>
                    <td>
                      <input
                        disabled={locked || !canManage}
                        required
                        value={line.unit_price}
                        onChange={(event) => updateLine(index, { unit_price: event.target.value })}
                        style={{ width: 90 }}
                      />
                    </td>
                    {canSeeFinancials && (
                      <td>
                        <input
                          disabled={locked || !canManage}
                          value={line.cost_unit_price ?? ''}
                          onChange={(event) =>
                            updateLine(index, { cost_unit_price: event.target.value })
                          }
                          style={{ width: 90 }}
                        />
                      </td>
                    )}
                    <td>
                      <input
                        disabled={locked || !canManage}
                        value={line.weight_kg ?? ''}
                        onChange={(event) => updateLine(index, { weight_kg: event.target.value })}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      <input
                        disabled={locked || !canManage}
                        value={line.volume_cbm ?? ''}
                        onChange={(event) => updateLine(index, { volume_cbm: event.target.value })}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      <input
                        disabled={locked || !canManage}
                        value={line.package_no ?? ''}
                        onChange={(event) => updateLine(index, { package_no: event.target.value })}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      {canManage && !locked && draft.lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              lines: draft.lines.filter((_, lineIndex) => lineIndex !== index),
                            })
                          }
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section
            style={{
              background: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 18,
            }}
          >
            <h2 style={{ fontSize: 18, marginTop: 0 }}>费用、装箱与模板</h2>
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}
            >
              <label>
                折扣方式
                <select
                  disabled={locked || !canManage}
                  value={draft.discount_type}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      discount_type: event.target.value as 'none' | 'percent' | 'amount',
                    })
                  }
                  style={{ width: '100%' }}
                >
                  <option value="none">无</option>
                  <option value="percent">百分比</option>
                  <option value="amount">固定金额</option>
                </select>
              </label>
              <label>
                折扣值
                <input
                  disabled={locked || !canManage}
                  value={draft.discount_value}
                  onChange={(event) => setDraft({ ...draft, discount_value: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                运费
                <input
                  disabled={locked || !canManage}
                  value={draft.freight_amount}
                  onChange={(event) => setDraft({ ...draft, freight_amount: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                保险
                <input
                  disabled={locked || !canManage}
                  value={draft.insurance_amount}
                  onChange={(event) => setDraft({ ...draft, insurance_amount: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                税费
                <input
                  disabled={locked || !canManage}
                  value={draft.tax_amount}
                  onChange={(event) => setDraft({ ...draft, tax_amount: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              {canSeeFinancials && (
                <label>
                  内部费用
                  <input
                    disabled={locked || !canManage}
                    value={draft.internal_expenses}
                    onChange={(event) =>
                      setDraft({ ...draft, internal_expenses: event.target.value })
                    }
                    style={{ width: '100%' }}
                  />
                </label>
              )}
              <label>
                费用分摊
                <select
                  disabled={locked || !canManage}
                  value={draft.allocation_method}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      allocation_method: event.target.value as
                        | 'equal'
                        | 'value'
                        | 'weight'
                        | 'volume',
                    })
                  }
                  style={{ width: '100%' }}
                >
                  <option value="equal">均摊</option>
                  <option value="value">按货值</option>
                  <option value="weight">按重量</option>
                  <option value="volume">按体积</option>
                </select>
              </label>
              <label>
                装箱
                <select
                  disabled={locked || !canManage}
                  value={draft.packing_mode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      packing_mode: event.target.value as 'normal' | 'combined',
                    })
                  }
                  style={{ width: '100%' }}
                >
                  <option value="normal">普通装箱</option>
                  <option value="combined">合并装箱</option>
                </select>
              </label>
              <label>
                主题色
                <input
                  disabled={locked || !canManage}
                  type="color"
                  value={draft.theme_color}
                  onChange={(event) => setDraft({ ...draft, theme_color: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                LOGO
                <input
                  disabled={locked || !canManage}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) =>
                    void uploadBrandAsset('logo_file_id', event.target.files?.[0])
                  }
                />
              </label>
              <label>
                签章
                <input
                  disabled={locked || !canManage}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) =>
                    void uploadBrandAsset('signature_file_id', event.target.files?.[0])
                  }
                />
              </label>
            </div>
            <fieldset style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
              <legend>PDF 字段显隐</legend>
              {[
                ['thumbnail', '产品缩略图'],
                ['terms', '条款'],
                ['bank_info', '银行信息'],
                ['signature', '签章'],
              ].map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    disabled={locked || !canManage}
                    checked={draft.visible_fields?.[key] !== false}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        visible_fields: {
                          ...draft.visible_fields,
                          [key]: event.target.checked,
                        },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}
            >
              <label>
                条款
                <textarea
                  disabled={locked || !canManage}
                  rows={4}
                  value={draft.terms ?? ''}
                  onChange={(event) => setDraft({ ...draft, terms: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
              <label>
                银行信息
                <textarea
                  disabled={locked || !canManage}
                  rows={4}
                  value={draft.bank_info ?? ''}
                  onChange={(event) => setDraft({ ...draft, bank_info: event.target.value })}
                  style={{ width: '100%' }}
                />
              </label>
            </div>
          </section>
          {selected && (
            <section
              style={{
                display: 'grid',
                gridTemplateColumns: canSeeFinancials ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)',
                gap: 10,
              }}
            >
              {canSeeFinancials && (
                <>
                  <div style={{ background: '#fff', padding: 14, borderRadius: 8 }}>
                    成本
                    <br />
                    <strong>
                      {selected.pricing_currency} {selected.internal_totals?.cost_total ?? '-'}
                    </strong>
                  </div>
                  <div style={{ background: '#fff', padding: 14, borderRadius: 8 }}>
                    毛利
                    <br />
                    <strong>
                      {selected.pricing_currency} {selected.internal_totals?.gross_profit ?? '-'}
                    </strong>
                  </div>
                  <div style={{ background: '#fff', padding: 14, borderRadius: 8 }}>
                    毛利率
                    <br />
                    <strong>{grossMargin}</strong>
                  </div>
                </>
              )}
              <div style={{ background: '#fff', padding: 14, borderRadius: 8 }}>
                客户总额
                <br />
                <strong>
                  {selected.pricing_currency} {selected.totals.grand_total}
                </strong>
              </div>
            </section>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            {canManage && !locked && (
              <button type="submit" disabled={saving}>
                {saving ? '保存中…' : selected ? '保存新版本' : '创建草稿'}
              </button>
            )}
            {selected && canLock && !locked && (
              <button type="button" disabled={saving} onClick={() => void lockDocument()}>
                锁定快照
              </button>
            )}
          </div>
        </form>
        {selected && (
          <section
            style={{
              background: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 18,
              marginTop: 18,
            }}
          >
            <h2 style={{ fontSize: 18, marginTop: 0 }}>PDF 与客户追踪</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {DOCUMENT_TYPES.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  disabled={!canExport || saving}
                  onClick={() => void exportPdf(item.type)}
                >
                  导出{selected.status === 'draft' ? '草稿 ' : ' '} {item.label}
                </button>
              ))}
            </div>
            {exports.length > 0 && (
              <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>源版本</th>
                    <th>导出版本</th>
                    <th>水印</th>
                    <th>归档</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {exports.map((exported) => (
                    <tr key={exported.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                      <td style={{ textAlign: 'center', padding: 8 }}>
                        {exported.document_type.toUpperCase()}
                      </td>
                      <td style={{ textAlign: 'center' }}>v{exported.source_version}</td>
                      <td style={{ textAlign: 'center' }}>e{exported.export_version}</td>
                      <td style={{ textAlign: 'center' }}>{exported.is_draft ? '草稿' : '锁定'}</td>
                      <td style={{ textAlign: 'center' }}>
                        Files / {exported.file_id.slice(0, 8)}
                      </td>
                      <td>
                        {canShare && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void createLink(exported)}
                          >
                            创建固定追踪链接
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {canShare && links.length > 0 && (
              <>
                <h3>追踪事件</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th>固定版本</th>
                      <th>打开</th>
                      <th>下载</th>
                      <th>确认</th>
                      <th>状态</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((link) => (
                      <tr key={link.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                        <td style={{ padding: 8, textAlign: 'center' }}>
                          {link.document_type.toUpperCase()} v{link.source_version}/e
                          {link.export_version}
                        </td>
                        <td style={{ textAlign: 'center' }}>{link.events.opened}</td>
                        <td style={{ textAlign: 'center' }}>{link.events.downloaded}</td>
                        <td style={{ textAlign: 'center' }}>{link.events.confirmed}</td>
                        <td style={{ textAlign: 'center' }}>
                          {link.revoked_at
                            ? '已作废'
                            : link.confirmed_at
                              ? '客户已确认'
                              : '有效（不自动过期）'}
                        </td>
                        <td>
                          {!link.revoked_at && (
                            <button type="button" onClick={() => void revokeLink(link)}>
                              作废
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

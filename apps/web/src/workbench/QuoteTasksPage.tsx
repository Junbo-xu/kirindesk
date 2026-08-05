import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PageLoadFailure, PageLoadState, toPageLoadFailure } from '../components/PageLoadState';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  Currency,
  ProcurementQuotation,
  QuotationOverwriteSequence,
  QuoteTaskSummary,
  SupplierResponse,
} from '../lib/types';

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  ready: '已就绪',
  timeout: '超时',
  rate_limited: '限流',
  parse_failed: '解析失败',
  provider_failed: '供应商失败',
  manually_corrected: '人工校正',
};

const FAILED_STATUSES = new Set(['timeout', 'rate_limited', 'parse_failed', 'provider_failed']);

interface QuotationDraft {
  quotationId: string | null;
  supplierId: string;
  expectedVersion: number;
  currency: Currency;
  validUntil: string;
  sourceText: string;
  lines: Record<
    string,
    {
      quantity: string;
      unitPrice: string;
      minimumQuantity: string;
      leadTimeDays: string;
      terms: string;
    }
  >;
}

function futureDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
}

function newDraft(task: QuoteTaskSummary, supplierId = ''): QuotationDraft {
  return {
    quotationId: null,
    supplierId,
    expectedVersion: 0,
    currency: 'USD',
    validUntil: futureDate(),
    sourceText: '',
    lines: Object.fromEntries(
      task.items.map((item) => [
        item.inquiry_item_id,
        {
          quantity: item.quantity,
          unitPrice: '',
          minimumQuantity: '',
          leadTimeDays: '',
          terms: '',
        },
      ]),
    ),
  };
}

function correctionDraft(quotation: ProcurementQuotation): QuotationDraft {
  return {
    quotationId: quotation.id,
    supplierId: quotation.supplier_id,
    expectedVersion: quotation.version,
    currency: quotation.currency,
    validUntil: quotation.valid_until.slice(0, 10),
    sourceText: quotation.source_text ?? '',
    lines: Object.fromEntries(
      quotation.lines.map((line) => [
        line.inquiry_item_id,
        {
          quantity: line.quantity,
          unitPrice: line.unit_price,
          minimumQuantity: line.minimum_quantity ?? '',
          leadTimeDays: line.lead_time_days === null ? '' : String(line.lead_time_days),
          terms: line.terms ?? '',
        },
      ]),
    ),
  };
}

export function QuoteTasksPage() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState<QuoteTaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [quotations, setQuotations] = useState<ProcurementQuotation[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierResponse[]>([]);
  const [draft, setDraft] = useState<QuotationDraft | null>(null);
  const [history, setHistory] = useState<QuotationOverwriteSequence | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<PageLoadFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );

  async function loadQuotations(taskId: string) {
    setHistory(null);
    setQuotations(taskId ? await apiClient.listTaskQuotations(taskId) : []);
  }

  async function loadPage(preferredId?: string) {
    setLoading(true);
    setLoadFailure(null);
    try {
      const [tasks, supplierResult] = await Promise.all([
        apiClient.listQuoteTasks(),
        hasPermission('quotations:manage') && hasPermission('suppliers:view')
          ? apiClient.listSuppliers({ pageSize: 100, status: 'active' })
          : Promise.resolve({ data: [] as SupplierResponse[] }),
      ]);
      setRows(tasks);
      setSuppliers(supplierResult.data);
      const nextId = preferredId || selectedId || tasks[0]?.id || '';
      setSelectedId(nextId);
      await loadQuotations(nextId);
    } catch (caught) {
      setLoadFailure(toPageLoadFailure(caught, '报价任务加载失败'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPage();
  }, []);

  async function chooseTask(taskId: string) {
    setSelectedId(taskId);
    setDraft(null);
    setError(null);
    try {
      await loadQuotations(taskId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '报价加载失败');
    }
  }

  async function retryTask() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.retryQuoteTask(selected.id);
      await loadPage(selected.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重试失败');
    } finally {
      setBusy(false);
    }
  }

  function updateLine(
    inquiryItemId: string,
    field: 'quantity' | 'unitPrice' | 'minimumQuantity' | 'leadTimeDays' | 'terms',
    value: string,
  ) {
    if (!draft) return;
    setDraft({
      ...draft,
      lines: { ...draft.lines, [inquiryItemId]: { ...draft.lines[inquiryItemId], [field]: value } },
    });
  }

  async function saveQuotation(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft) return;
    if (!draft.supplierId) {
      setError('请选择供应商');
      return;
    }
    const lines = selected.items.map((item) => ({
      item,
      input: draft.lines[item.inquiry_item_id],
    }));
    if (lines.some(({ input }) => !input?.quantity || !input.unitPrice)) {
      setError('请填写全部产品行的数量和采购单价');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await apiClient.upsertTaskQuotation(selected.id, {
        supplier_id: draft.supplierId,
        expected_version: draft.expectedVersion,
        currency: draft.currency,
        valid_until: draft.validUntil,
        source_text: draft.sourceText || undefined,
        lines: lines.map(({ item, input }) => ({
          inquiry_item_id: item.inquiry_item_id,
          quantity: input.quantity,
          unit_price: input.unitPrice,
          minimum_quantity: input.minimumQuantity || undefined,
          lead_time_days: input.leadTimeDays ? Number(input.leadTimeDays) : undefined,
          terms: input.terms || undefined,
        })),
      });
      await loadPage(selected.id);
      setDraft(correctionDraft(saved));
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 409
          ? '报价版本已变化，请重新选择“校正报价”后再保存'
          : caught instanceof Error
            ? caught.message
            : '报价保存失败',
      );
    } finally {
      setBusy(false);
    }
  }

  async function showHistory(quotation: ProcurementQuotation) {
    setBusy(true);
    setError(null);
    try {
      setHistory(await apiClient.getQuotationOverwriteSequence(quotation.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '版本历史加载失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ maxWidth: 1180 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>报价任务</h1>
      <p style={{ color: '#64748b' }}>
        采购投影仅包含国家、脱敏产品行和任务状态，不返回客户名称、联系人、联系方式或客户原文。
      </p>
      <PageLoadState
        loading={loading}
        failure={loadFailure}
        loadingText="正在加载报价任务…"
        onRetry={() => void loadPage()}
      />
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}

      {!loading && !loadFailure && rows.length === 0 && (
        <p style={{ color: '#64748b' }}>暂无报价任务。</p>
      )}
      {!loading && !loadFailure && rows.length > 0 && (
        <>
          <label>
            当前任务
            <select
              aria-label="当前报价任务"
              value={selectedId}
              onChange={(event) => void chooseTask(event.target.value)}
            >
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.customer_country} ·{' '}
                  {STATUS_LABELS[row.sanitization_status] ?? row.sanitization_status}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <article
              style={{
                background: 'white',
                border: '1px solid #e2e8f0',
                borderRadius: 9,
                padding: 14,
                margin: '12px 0',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>
                  {selected.customer_country} · {selected.items.length} 个脱敏产品行
                </strong>
                <span>
                  {STATUS_LABELS[selected.sanitization_status] ?? selected.sanitization_status}
                </span>
              </div>
              {selected.sanitized_summary && <p>{selected.sanitized_summary}</p>}
              {selected.last_error_code && (
                <p style={{ color: '#b45309' }}>失败代码：{selected.last_error_code}</p>
              )}
              <div style={{ color: '#64748b', fontSize: 12 }}>
                尝试次数：{selected.attempt_count}
              </div>
              {FAILED_STATUSES.has(selected.sanitization_status) &&
                hasPermission('quotations:manage') && (
                  <button type="button" disabled={busy} onClick={() => void retryTask()}>
                    {busy ? '重试中…' : '幂等重试脱敏任务'}
                  </button>
                )}
            </article>
          )}

          {selected &&
            ['ready', 'manually_corrected'].includes(selected.sanitization_status) &&
            hasPermission('quotations:manage') && (
              <button type="button" onClick={() => setDraft(newDraft(selected, suppliers[0]?.id))}>
                录入供应商报价
              </button>
            )}

          {draft && selected && (
            <form
              onSubmit={saveQuotation}
              style={{ background: 'white', padding: 16, borderRadius: 10, margin: '12px 0' }}
            >
              <h2>{draft.quotationId ? `校正报价 v${draft.expectedVersion}` : '录入供应商报价'}</h2>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label>
                  供应商
                  <select
                    aria-label="报价供应商"
                    disabled={draft.quotationId !== null}
                    value={draft.supplierId}
                    onChange={(event) => setDraft({ ...draft, supplierId: event.target.value })}
                  >
                    <option value="">选择供应商</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.company_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  币种
                  <select
                    aria-label="报价币种"
                    value={draft.currency}
                    onChange={(event) =>
                      setDraft({ ...draft, currency: event.target.value as Currency })
                    }
                  >
                    {(['RMB', 'USD', 'HKD', 'EUR'] as const).map((currency) => (
                      <option key={currency}>{currency}</option>
                    ))}
                  </select>
                </label>
                <label>
                  有效期
                  <input
                    aria-label="报价有效期"
                    type="date"
                    value={draft.validUntil}
                    onChange={(event) => setDraft({ ...draft, validUntil: event.target.value })}
                  />
                </label>
                <label>
                  来源原文
                  <input
                    aria-label="报价来源原文"
                    value={draft.sourceText}
                    onChange={(event) => setDraft({ ...draft, sourceText: event.target.value })}
                  />
                </label>
              </div>
              {selected.items.map((item, index) => {
                const line = draft.lines[item.inquiry_item_id];
                return (
                  <fieldset key={item.inquiry_item_id} style={{ marginTop: 10 }}>
                    <legend>
                      {index + 1}. {item.description}
                    </legend>
                    <input
                      aria-label={`第 ${index + 1} 行报价数量`}
                      placeholder="数量"
                      value={line?.quantity ?? ''}
                      onChange={(event) =>
                        updateLine(item.inquiry_item_id, 'quantity', event.target.value)
                      }
                    />
                    <input
                      aria-label={`第 ${index + 1} 行采购单价`}
                      placeholder="采购单价"
                      value={line?.unitPrice ?? ''}
                      onChange={(event) =>
                        updateLine(item.inquiry_item_id, 'unitPrice', event.target.value)
                      }
                    />
                    <input
                      aria-label={`第 ${index + 1} 行起订量`}
                      placeholder="起订量"
                      value={line?.minimumQuantity ?? ''}
                      onChange={(event) =>
                        updateLine(item.inquiry_item_id, 'minimumQuantity', event.target.value)
                      }
                    />
                    <input
                      aria-label={`第 ${index + 1} 行交期`}
                      placeholder="交期（天）"
                      type="number"
                      min="0"
                      value={line?.leadTimeDays ?? ''}
                      onChange={(event) =>
                        updateLine(item.inquiry_item_id, 'leadTimeDays', event.target.value)
                      }
                    />
                    <input
                      aria-label={`第 ${index + 1} 行条款`}
                      placeholder="条款"
                      value={line?.terms ?? ''}
                      onChange={(event) =>
                        updateLine(item.inquiry_item_id, 'terms', event.target.value)
                      }
                    />
                  </fieldset>
                );
              })}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button disabled={busy}>{busy ? '保存中…' : '保存报价版本'}</button>
                <button type="button" onClick={() => setDraft(null)}>
                  取消
                </button>
              </div>
            </form>
          )}

          <h2>当前供应商报价</h2>
          {quotations.length === 0 ? (
            <p style={{ color: '#64748b' }}>尚未录入报价。</p>
          ) : (
            quotations.map((quotation) => (
              <article
                key={quotation.id}
                style={{ background: 'white', padding: 14, marginBottom: 10 }}
              >
                <strong>
                  {suppliers.find((supplier) => supplier.id === quotation.supplier_id)
                    ?.company_name ?? quotation.supplier_id}{' '}
                  · v{quotation.version}
                </strong>
                <p>
                  {quotation.currency} · 有效期 {quotation.valid_until.slice(0, 10)} ·{' '}
                  {quotation.lines.length} 行
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  {hasPermission('quotations:manage') && (
                    <button type="button" onClick={() => setDraft(correctionDraft(quotation))}>
                      校正报价
                    </button>
                  )}
                  {hasPermission('quotations:audit') && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void showHistory(quotation)}
                    >
                      版本历史
                    </button>
                  )}
                </div>
              </article>
            ))
          )}

          {history && (
            <section aria-label="报价版本历史" style={{ background: '#f8fafc', padding: 14 }}>
              <h2>报价版本历史 · 当前 v{history.current_version}</h2>
              {history.sequence.map((event) => (
                <p key={event.event_id}>
                  v{String(event.after.version)} ·{' '}
                  {event.action === 'supplier_quotation.created' ? '首次录入' : '校正'} ·{' '}
                  {new Date(event.created_at).toLocaleString('zh-CN')}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}

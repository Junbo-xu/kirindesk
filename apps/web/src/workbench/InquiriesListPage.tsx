import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { PageLoadFailure, PageLoadState } from '../components/PageLoadState';
import { apiClient } from '../lib/api-client';
import { ApiError, CreateInquiryInput, InquirySummary } from '../lib/types';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  quoting: '报价中',
  quoted: '已报价',
  selected: '已选价',
};

interface InquiryDraft extends CreateInquiryInput {
  id: string | null;
  expected_version: number | null;
}

function emptyDraft(): InquiryDraft {
  return {
    id: null,
    expected_version: null,
    customer_code: '',
    customer_country: '',
    customer_message: '',
    items: [{ description: '', specifications: '', quantity: '', unit: '', target_price_usd: '' }],
  };
}

function draftFromInquiry(inquiry: InquirySummary): InquiryDraft {
  return {
    id: inquiry.id,
    expected_version: inquiry.source_version,
    customer_code: inquiry.customer_code,
    customer_country: inquiry.customer_country,
    customer_message: inquiry.customer_message,
    items: inquiry.items.map((item) => ({
      description: item.description,
      specifications: item.specifications ?? '',
      quantity: item.quantity,
      unit: item.unit,
      target_price_usd: item.target_price_usd ?? '',
    })),
  };
}

export function InquiriesListPage() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState<InquirySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<PageLoadFailure | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<InquiryDraft | null>(null);

  async function load() {
    setLoading(true);
    setLoadFailure(null);
    try {
      setRows(await apiClient.listInquiries());
    } catch (error) {
      setLoadFailure({
        status: error instanceof ApiError ? error.status : null,
        message: error instanceof Error ? error.message : '询盘加载失败',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function validateDraft(value: InquiryDraft): string | null {
    if (
      !value.customer_code.trim() ||
      !value.customer_country.trim() ||
      !value.customer_message.trim()
    ) {
      return '请填写客户代号、国家/地区和客户原始需求';
    }
    if (value.items.length === 0) return '询盘至少需要一个产品行';
    const quantityPattern = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/;
    const pricePattern = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
    for (const [index, item] of value.items.entries()) {
      if (!item.description.trim() || !item.unit.trim()) return `第 ${index + 1} 行缺少产品或单位`;
      if (!quantityPattern.test(item.quantity) || Number(item.quantity) <= 0) {
        return `第 ${index + 1} 行数量必须为大于 0 且最多 3 位小数`;
      }
      if (item.target_price_usd && !pricePattern.test(item.target_price_usd)) {
        return `第 ${index + 1} 行目标价格式不正确`;
      }
    }
    return null;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const validationError = validateDraft(draft);
    if (validationError) {
      setActionError(validationError);
      return;
    }
    setBusy(draft.id ?? 'new');
    setActionError(null);
    try {
      const input: CreateInquiryInput = {
        customer_code: draft.customer_code,
        customer_country: draft.customer_country,
        customer_message: draft.customer_message,
        items: draft.items.map((item) => ({
          ...item,
          specifications: item.specifications || undefined,
          target_price_usd: item.target_price_usd || undefined,
        })),
      };
      if (draft.id && draft.expected_version !== null) {
        await apiClient.updateInquiry(draft.id, {
          ...input,
          expected_version: draft.expected_version,
        });
      } else {
        await apiClient.createInquiry(input);
      }
      setDraft(null);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setActionError('询盘版本已变化，请关闭编辑后重新打开最新草稿');
        await load();
      } else {
        setActionError(error instanceof Error ? error.message : '保存失败');
      }
    } finally {
      setBusy(null);
    }
  }

  async function submit(row: InquirySummary) {
    setBusy(row.id);
    setActionError(null);
    try {
      await apiClient.submitInquiry(row.id, row.source_version);
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setActionError('提交前草稿已变化，已刷新最新版本，请重试');
        await load();
      } else {
        setActionError(error instanceof Error ? error.message : '提交失败');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ maxWidth: 1100 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, marginTop: 0 }}>询盘</h1>
          <p style={{ color: '#64748b' }}>
            仅列出服务端数据范围内的询盘；采购角色无法通过此页面读取客户原文。
          </p>
        </div>
        {hasPermission('inquiries:create') && (
          <button
            type="button"
            onClick={() => setDraft((current) => (current ? null : emptyDraft()))}
          >
            {draft ? '关闭表单' : '新建询盘'}
          </button>
        )}
      </header>

      <PageLoadState
        loading={loading}
        failure={loadFailure}
        loadingText="正在加载询盘…"
        onRetry={() => void load()}
      />
      {actionError && (
        <p role="alert" style={{ color: 'crimson' }}>
          {actionError}
        </p>
      )}

      {draft && (
        <form
          onSubmit={save}
          style={{ background: 'white', padding: 16, borderRadius: 10, marginBottom: 16 }}
        >
          <h2 style={{ marginTop: 0 }}>
            {draft.id ? `编辑草稿 v${draft.expected_version}` : '新建询盘'}
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <label>
              客户代号
              <input
                aria-label="客户代号"
                value={draft.customer_code}
                onChange={(event) => setDraft({ ...draft, customer_code: event.target.value })}
              />
            </label>
            <label>
              国家/地区
              <input
                aria-label="国家/地区"
                value={draft.customer_country}
                onChange={(event) => setDraft({ ...draft, customer_country: event.target.value })}
              />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              客户原始需求
              <textarea
                aria-label="客户原始需求"
                value={draft.customer_message}
                onChange={(event) => setDraft({ ...draft, customer_message: event.target.value })}
              />
            </label>
          </div>
          <h3>产品行</h3>
          {draft.items.map((item, index) => (
            <fieldset key={index} style={{ border: '1px solid #e2e8f0', marginBottom: 10 }}>
              <legend>第 {index + 1} 行</legend>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr 1fr', gap: 8 }}>
                <input
                  aria-label={`第 ${index + 1} 行产品`}
                  placeholder="产品"
                  value={item.description}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, description: event.target.value } : row,
                      ),
                    })
                  }
                />
                <input
                  aria-label={`第 ${index + 1} 行规格`}
                  placeholder="规格"
                  value={item.specifications ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, specifications: event.target.value } : row,
                      ),
                    })
                  }
                />
                <input
                  aria-label={`第 ${index + 1} 行数量`}
                  placeholder="数量"
                  inputMode="decimal"
                  value={item.quantity}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, quantity: event.target.value } : row,
                      ),
                    })
                  }
                />
                <input
                  aria-label={`第 ${index + 1} 行单位`}
                  placeholder="单位"
                  value={item.unit}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, unit: event.target.value } : row,
                      ),
                    })
                  }
                />
                <input
                  aria-label={`第 ${index + 1} 行目标价`}
                  placeholder="USD 目标价"
                  inputMode="decimal"
                  value={item.target_price_usd ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      items: draft.items.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, target_price_usd: event.target.value } : row,
                      ),
                    })
                  }
                />
              </div>
              <button
                type="button"
                disabled={draft.items.length === 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    items: draft.items.filter((_, rowIndex) => rowIndex !== index),
                  })
                }
              >
                删除此行
              </button>
            </fieldset>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  items: [
                    ...draft.items,
                    {
                      description: '',
                      specifications: '',
                      quantity: '',
                      unit: '',
                      target_price_usd: '',
                    },
                  ],
                })
              }
            >
              添加产品行
            </button>
            <button disabled={busy !== null} type="submit">
              {busy ? '保存中…' : '保存草稿'}
            </button>
          </div>
        </form>
      )}

      {!loading && !loadFailure && rows.length === 0 ? (
        <p style={{ color: '#64748b' }}>暂无询盘。</p>
      ) : !loading && !loadFailure ? (
        rows.map((row) => (
          <article
            key={row.id}
            style={{
              background: 'white',
              border: '1px solid #e2e8f0',
              borderRadius: 9,
              padding: 14,
              marginBottom: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{row.customer_code}</strong>
              <span>
                {STATUS_LABELS[row.status] ?? row.status} · v{row.source_version}
              </span>
            </div>
            <div style={{ color: '#64748b', marginTop: 5 }}>
              {row.customer_country} · {row.items.length} 个产品行
            </div>
            {row.status === 'draft' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {hasPermission('inquiries:update') && (
                  <button type="button" onClick={() => setDraft(draftFromInquiry(row))}>
                    编辑草稿
                  </button>
                )}
                {hasPermission('inquiries:submit') && (
                  <button type="button" disabled={busy === row.id} onClick={() => void submit(row)}>
                    {busy === row.id ? '提交中…' : '提交询盘'}
                  </button>
                )}
              </div>
            )}
          </article>
        ))
      ) : null}
    </section>
  );
}

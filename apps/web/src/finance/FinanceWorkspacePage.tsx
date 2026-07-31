import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CommissionBasisType,
  CommissionRoleType,
  FinanceConversionInput,
  FinanceOrderDetail,
  FinanceOrderSummary,
  FinanceSource,
} from '../lib/types';
import './FinanceWorkspacePage.css';

type RuleDraft = Record<CommissionRoleType, { basis: CommissionBasisType; rateBps: string }>;
type AllocationDraft = Record<
  CommissionRoleType,
  Array<{ key: number; userId: string; sharePercent: string }>
>;
type ConversionDraft = Record<string, { rate: string; source: string; capturedAt: string }>;

const roleLabel: Record<CommissionRoleType, string> = {
  sales: '销售提成',
  procurement: '采购提成',
};

const basisLabel: Record<CommissionBasisType, string> = {
  sales_revenue: '销售额',
  gross_profit: '毛利',
  net_profit: '净利',
};

const missingLabel: Record<string, string> = {
  missing_receipt: '缺收款',
  missing_cost: '缺采购成本',
  missing_freight: '缺运费',
  missing_fx: '缺换汇证据',
  missing_current_finance_review: '缺当前财务核对',
};

const emptyRules: RuleDraft = {
  sales: { basis: 'gross_profit', rateBps: '0' },
  procurement: { basis: 'net_profit', rateBps: '0' },
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : '操作失败';
}

function money(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}

function sourceName(source: FinanceSource): string {
  if (source.subject_type === 'customer_receipt') return '客户收款';
  if (source.subject_type === 'purchase_cost') return '采购成本';
  const labels: Record<string, string> = {
    freight: '运费',
    insurance: '保险费',
    customs: '报关费',
    other: '其他费用',
  };
  return labels[source.expense_type ?? ''] ?? '订单费用';
}

function badgeTone(value: string | null): string {
  if (value === 'verified' || value === 'final' || value === 'locked') return 'ok';
  if (value === 'returned') return 'danger';
  return 'warn';
}

export function FinanceWorkspacePage() {
  const { hasPermission } = useAuth();
  const [orders, setOrders] = useState<FinanceOrderSummary[]>([]);
  const [orderId, setOrderId] = useState('');
  const [detail, setDetail] = useState<FinanceOrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState('');
  const [lockComment, setLockComment] = useState('');
  const [revisionReason, setRevisionReason] = useState('');
  const [conversions, setConversions] = useState<ConversionDraft>({});
  const [rules, setRules] = useState<RuleDraft>(emptyRules);
  const [allocations, setAllocations] = useState<AllocationDraft>({ sales: [], procurement: [] });
  const [nextParticipantKey, setNextParticipantKey] = useState(1);
  const loadSequence = useRef(0);

  const allSources = useMemo(
    () =>
      detail
        ? [
            ...detail.source_state.receipts,
            ...detail.source_state.purchase_costs,
            ...detail.source_state.expenses,
          ]
        : [],
    [detail],
  );
  const latestProfit = detail?.profit_snapshots[0] ?? null;
  const latestCandidate = detail?.commission_candidates[0] ?? null;

  async function loadOrder(id: string) {
    if (!id) {
      setDetail(null);
      return;
    }
    const sequence = ++loadSequence.current;
    const response = await apiClient.getFinanceOrder(id);
    if (sequence !== loadSequence.current) return;
    setDetail(response);
    setReturnReason('');
    setRevisionReason('');
    setLockComment('');
    setConversions({});

    const nextRules: RuleDraft = {
      sales: { ...emptyRules.sales },
      procurement: { ...emptyRules.procurement },
    };
    for (const rule of response.commission_rules) {
      nextRules[rule.role_type] = {
        basis: rule.basis_type,
        rateBps: String(rule.rate_bps),
      };
    }
    setRules(nextRules);

    const salesUser = response.participants.find(
      (user) => user.id === response.order.owner_user_id,
    );
    const procurementUser = response.participants.find((user) => user.id !== salesUser?.id);
    let key = nextParticipantKey;
    setAllocations({
      sales: salesUser ? [{ key: key++, userId: salesUser.id, sharePercent: '100' }] : [],
      procurement: procurementUser
        ? [{ key: key++, userId: procurementUser.id, sharePercent: '100' }]
        : [],
    });
    setNextParticipantKey(key);
  }

  async function loadOrders(preferredId?: string) {
    const response = await apiClient.listFinanceOrders();
    setOrders(response);
    const nextId = preferredId || orderId || response[0]?.id || '';
    setOrderId(nextId);
    await loadOrder(nextId);
  }

  useEffect(() => {
    void loadOrders().catch((caught) => setError(errorMessage(caught)));
  }, []);

  async function run(action: () => Promise<unknown>) {
    if (!orderId) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadOrders(orderId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function updateConversion(id: string, field: 'rate' | 'source' | 'capturedAt', value: string) {
    setConversions((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { rate: '', source: '', capturedAt: '' }), [field]: value },
    }));
  }

  function conversionPayload(required: boolean): FinanceConversionInput[] | null {
    const result: FinanceConversionInput[] = [];
    for (const source of allSources.filter((row) => row.needs_fx)) {
      const draft = conversions[source.id];
      if (!draft?.rate || !draft.source || !draft.capturedAt) {
        if (required) return null;
        continue;
      }
      result.push({
        subject_type: source.subject_type as 'customer_receipt' | 'purchase_cost',
        subject_id: source.id,
        fx_rate_to_rmb: draft.rate,
        fx_source: draft.source,
        fx_captured_at: new Date(draft.capturedAt).toISOString(),
      });
    }
    return result;
  }

  function submitReview(decision: 'verified' | 'returned') {
    const payload = conversionPayload(decision === 'verified');
    if (!payload) {
      setError('请补全所有外币收款与采购成本的汇率、来源和取值时间');
      return;
    }
    if (decision === 'returned' && !returnReason.trim()) {
      setError('打回必须填写原因');
      return;
    }
    void run(() =>
      apiClient.createFinanceReview(orderId, {
        decision,
        reason: decision === 'returned' ? returnReason : undefined,
        conversions: payload,
      }),
    );
  }

  function updateRule(role: CommissionRoleType, patch: Partial<RuleDraft[CommissionRoleType]>) {
    setRules((current) => ({ ...current, [role]: { ...current[role], ...patch } }));
  }

  function saveRules() {
    void run(() =>
      apiClient.replaceFinanceCommissionRules(
        (['sales', 'procurement'] as const).map((role) => ({
          role_type: role,
          basis_type: rules[role].basis,
          rate_bps: Number(rules[role].rateBps),
        })),
      ),
    );
  }

  function addParticipant(role: CommissionRoleType) {
    const user = detail?.participants.find(
      (candidate) => !allocations[role].some((row) => row.userId === candidate.id),
    );
    if (!user) return;
    const key = nextParticipantKey;
    setNextParticipantKey(key + 1);
    setAllocations((current) => ({
      ...current,
      [role]: [...current[role], { key, userId: user.id, sharePercent: '0' }],
    }));
  }

  function updateParticipant(
    role: CommissionRoleType,
    key: number,
    patch: Partial<{ userId: string; sharePercent: string }>,
  ) {
    setAllocations((current) => ({
      ...current,
      [role]: current[role].map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  }

  function removeParticipant(role: CommissionRoleType, key: number) {
    setAllocations((current) => ({
      ...current,
      [role]: current[role].filter((row) => row.key !== key),
    }));
  }

  function calculateCandidate() {
    const mapped = (['sales', 'procurement'] as const).map((role) => ({
      role_type: role,
      participants: allocations[role].map((row) => ({
        user_id: row.userId,
        share_bps: Math.round(Number(row.sharePercent) * 100),
      })),
    }));
    const invalid = mapped.some(
      (allocation) =>
        allocation.participants.length === 0 ||
        new Set(allocation.participants.map((row) => row.user_id)).size !==
          allocation.participants.length ||
        allocation.participants.reduce((sum, row) => sum + row.share_bps, 0) !== 10000,
    );
    if (invalid) {
      setError('销售和采购的人员比例必须分别合计 100%，且人员不能重复');
      return;
    }
    if (latestCandidate?.status === 'locked' && !revisionReason.trim()) {
      setError('锁定后的修订必须填写原因');
      return;
    }
    void run(() =>
      apiClient.calculateFinanceCommissionCandidate(orderId, {
        allocations: mapped,
        revision_reason: latestCandidate?.status === 'locked' ? revisionReason : undefined,
      }),
    );
  }

  return (
    <section className="finance-workspace" data-testid="finance-workspace">
      <header className="finance-heading">
        <h1>财务核对、利润与提成</h1>
        <button
          className="finance-icon-button"
          type="button"
          title="刷新"
          aria-label="刷新"
          disabled={busy}
          onClick={() => void loadOrders(orderId).catch((caught) => setError(errorMessage(caught)))}
        >
          ↻
        </button>
      </header>

      {error && (
        <p className="finance-alert" role="alert">
          {error}
        </p>
      )}

      <div className="finance-grid">
        <aside className="finance-order-list">
          <h2>待核对订单</h2>
          {orders.map((order) => (
            <button
              key={order.id}
              type="button"
              className="finance-order-button"
              aria-current={order.id === orderId}
              onClick={() => {
                setOrderId(order.id);
                void loadOrder(order.id).catch((caught) => setError(errorMessage(caught)));
              }}
            >
              <strong>{order.order_number}</strong>
              <span>
                {order.currency} {order.total_amount} · {order.finance_decision ?? '未核对'}
              </span>
            </button>
          ))}
          {orders.length === 0 && <p className="finance-empty">暂无待核对订单</p>}
        </aside>

        <main>
          {!detail && <p className="finance-empty">请选择订单</p>}
          {detail && (
            <>
              <header className="finance-order-header">
                <div>
                  <h2>{detail.order.order_number}</h2>
                  <p>
                    {detail.order.currency} {detail.order.total_amount} · {detail.order.status}
                  </p>
                </div>
                <div className="finance-badges">
                  <span
                    className={`finance-badge ${badgeTone(detail.finance_reviews[0]?.decision ?? null)}`}
                  >
                    核对 {detail.finance_reviews[0]?.decision ?? 'pending'}
                  </span>
                  <span className={`finance-badge ${badgeTone(latestProfit?.status ?? null)}`}>
                    利润 {latestProfit?.status ?? 'pending'}
                  </span>
                  <span className={`finance-badge ${badgeTone(latestCandidate?.status ?? null)}`}>
                    提成 {latestCandidate?.status ?? 'pending'}
                  </span>
                </div>
              </header>

              <section className="finance-section">
                <div className="finance-section-header">
                  <h2>财务来源</h2>
                  <span
                    className={`finance-badge ${detail.source_state.missing_items.length ? 'danger' : 'ok'}`}
                  >
                    {detail.source_state.missing_items.length
                      ? detail.source_state.missing_items
                          .map((item) => missingLabel[item] ?? item.split(':')[0])
                          .join('、')
                      : '资料完整'}
                  </span>
                </div>
                <div className="finance-table-wrap">
                  <table className="finance-table">
                    <thead>
                      <tr>
                        <th>项目</th>
                        <th>原币金额</th>
                        <th>人民币金额</th>
                        <th>换汇证据</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allSources.map((source) => (
                        <tr key={`${source.subject_type}:${source.id}`}>
                          <td>{sourceName(source)}</td>
                          <td>
                            {source.currency} {source.amount}
                          </td>
                          <td>{money(source.amount_rmb)}</td>
                          <td>
                            {source.needs_fx ? (
                              <div className="finance-fx-grid">
                                <input
                                  className="finance-input"
                                  aria-label={`${sourceName(source)}汇率`}
                                  inputMode="decimal"
                                  placeholder="汇率"
                                  value={conversions[source.id]?.rate ?? ''}
                                  onChange={(event) =>
                                    updateConversion(source.id, 'rate', event.target.value)
                                  }
                                />
                                <input
                                  className="finance-input"
                                  aria-label={`${sourceName(source)}汇率来源`}
                                  placeholder="来源"
                                  value={conversions[source.id]?.source ?? ''}
                                  onChange={(event) =>
                                    updateConversion(source.id, 'source', event.target.value)
                                  }
                                />
                                <input
                                  className="finance-input"
                                  aria-label={`${sourceName(source)}汇率时间`}
                                  type="datetime-local"
                                  value={conversions[source.id]?.capturedAt ?? ''}
                                  onChange={(event) =>
                                    updateConversion(source.id, 'capturedAt', event.target.value)
                                  }
                                />
                              </div>
                            ) : (
                              `${source.fx_source ?? '待核对'}${
                                source.fx_rate_to_rmb ? ` · ${source.fx_rate_to_rmb}` : ''
                              }`
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {hasPermission('finance_reviews:review') && (
                  <>
                    <label className="finance-field" style={{ marginTop: 12 }}>
                      打回原因
                      <textarea
                        className="finance-textarea"
                        value={returnReason}
                        onChange={(event) => setReturnReason(event.target.value)}
                      />
                    </label>
                    <div className="finance-actions">
                      <button
                        className="finance-button danger"
                        type="button"
                        disabled={busy}
                        onClick={() => submitReview('returned')}
                      >
                        打回
                      </button>
                      <button
                        className="finance-button"
                        type="button"
                        disabled={busy}
                        onClick={() => submitReview('verified')}
                      >
                        核对通过
                      </button>
                    </div>
                  </>
                )}

                <div className="finance-history" data-testid="finance-review-history">
                  {detail.finance_reviews.map((review) => (
                    <div className="finance-history-row" key={review.id}>
                      <strong>v{review.version}</strong>
                      <span className={`finance-badge ${badgeTone(review.decision)}`}>
                        {review.decision}
                      </span>
                      <span>{review.reason ?? '核对通过'}</span>
                      <time>{new Date(review.reviewed_at).toLocaleString('zh-CN')}</time>
                    </div>
                  ))}
                </div>
              </section>

              <section className="finance-section">
                <div className="finance-section-header">
                  <h2>利润快照</h2>
                  {latestProfit && (
                    <span className={`finance-badge ${badgeTone(latestProfit.status)}`}>
                      v{latestProfit.version} · {latestProfit.formula_version}
                    </span>
                  )}
                </div>
                {latestProfit && (
                  <div className="finance-metrics" data-testid="profit-metrics">
                    <div className="finance-metric">
                      <span>销售收入</span>
                      <strong>{money(latestProfit.revenue_rmb)}</strong>
                    </div>
                    <div className="finance-metric">
                      <span>采购成本</span>
                      <strong>{money(latestProfit.purchase_cost_rmb)}</strong>
                    </div>
                    <div className="finance-metric">
                      <span>运费 / 其他费用</span>
                      <strong>
                        {money(latestProfit.freight_rmb)} / {money(latestProfit.other_expense_rmb)}
                      </strong>
                    </div>
                    <div className="finance-metric">
                      <span>毛利</span>
                      <strong>{money(latestProfit.gross_profit_rmb)}</strong>
                    </div>
                    <div className="finance-metric">
                      <span>净利</span>
                      <strong>{money(latestProfit.net_profit_rmb)}</strong>
                    </div>
                    <div className="finance-metric">
                      <span>输入指纹</span>
                      <strong title={latestProfit.input_fingerprint}>
                        {latestProfit.input_fingerprint.slice(0, 10)}
                      </strong>
                    </div>
                  </div>
                )}
                {hasPermission('profit_snapshots:create') && (
                  <div className="finance-actions">
                    <button
                      className="finance-button secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() => apiClient.createProfitSnapshot(orderId, 'provisional'))
                      }
                    >
                      生成暂算快照
                    </button>
                    <button
                      className="finance-button"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() => apiClient.createProfitSnapshot(orderId, 'final'))
                      }
                    >
                      生成最终利润
                    </button>
                  </div>
                )}
              </section>

              <section className="finance-section">
                <div className="finance-section-header">
                  <h2>提成规则</h2>
                  <span className="finance-badge">基点 / 10,000</span>
                </div>
                <div className="finance-rule-grid">
                  {(['sales', 'procurement'] as const).map((role) => (
                    <div className="finance-allocation" key={role}>
                      <strong>{roleLabel[role]}</strong>
                      <label className="finance-field" style={{ marginTop: 8 }}>
                        计算基数
                        <select
                          className="finance-select"
                          value={rules[role].basis}
                          disabled={!hasPermission('commission_rules:manage')}
                          onChange={(event) =>
                            updateRule(role, { basis: event.target.value as CommissionBasisType })
                          }
                        >
                          {Object.entries(basisLabel).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="finance-field">
                        比例（基点）
                        <input
                          className="finance-input"
                          type="number"
                          min="0"
                          max="100000"
                          value={rules[role].rateBps}
                          disabled={!hasPermission('commission_rules:manage')}
                          onChange={(event) => updateRule(role, { rateBps: event.target.value })}
                        />
                      </label>
                    </div>
                  ))}
                </div>
                {hasPermission('commission_rules:manage') && (
                  <button
                    className="finance-button secondary"
                    type="button"
                    disabled={busy}
                    onClick={saveRules}
                  >
                    追加规则版本
                  </button>
                )}
              </section>

              <section className="finance-section">
                <div className="finance-section-header">
                  <h2>提成分配</h2>
                  {latestCandidate && (
                    <span className={`finance-badge ${badgeTone(latestCandidate.status)}`}>
                      v{latestCandidate.version} · {money(latestCandidate.total_commission_rmb)}
                    </span>
                  )}
                </div>
                {(['sales', 'procurement'] as const).map((role) => (
                  <div className="finance-allocation" key={role}>
                    <div className="finance-allocation-header">
                      <strong>{roleLabel[role]}</strong>
                      <button
                        className="finance-button secondary"
                        type="button"
                        disabled={busy || allocations[role].length >= detail.participants.length}
                        onClick={() => addParticipant(role)}
                      >
                        添加人员
                      </button>
                    </div>
                    {allocations[role].map((participant) => (
                      <div className="finance-participant-row" key={participant.key}>
                        <select
                          className="finance-select"
                          aria-label={`${roleLabel[role]}人员`}
                          value={participant.userId}
                          onChange={(event) =>
                            updateParticipant(role, participant.key, { userId: event.target.value })
                          }
                        >
                          {detail.participants.map((user) => (
                            <option key={user.id} value={user.id}>
                              {user.name} · {user.email}
                            </option>
                          ))}
                        </select>
                        <input
                          className="finance-input"
                          aria-label={`${roleLabel[role]}比例`}
                          type="number"
                          min="0.01"
                          max="100"
                          step="0.01"
                          value={participant.sharePercent}
                          onChange={(event) =>
                            updateParticipant(role, participant.key, {
                              sharePercent: event.target.value,
                            })
                          }
                        />
                        <button
                          className="finance-icon-button"
                          type="button"
                          title="移除人员"
                          aria-label="移除人员"
                          onClick={() => removeParticipant(role, participant.key)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ))}

                {latestCandidate?.status === 'locked' && (
                  <label className="finance-field">
                    修订原因
                    <textarea
                      className="finance-textarea"
                      value={revisionReason}
                      onChange={(event) => setRevisionReason(event.target.value)}
                    />
                  </label>
                )}
                {hasPermission('commission_candidates:calculate') && (
                  <button
                    className="finance-button"
                    type="button"
                    disabled={busy}
                    onClick={calculateCandidate}
                  >
                    {latestCandidate?.status === 'locked' ? '追加修订版本' : '计算提成候选'}
                  </button>
                )}

                {latestCandidate?.status === 'calculated' &&
                  hasPermission('commission_candidates:lock') && (
                    <div className="finance-actions">
                      <input
                        className="finance-input"
                        style={{ maxWidth: 360 }}
                        aria-label="锁定备注"
                        placeholder="锁定备注"
                        value={lockComment}
                        onChange={(event) => setLockComment(event.target.value)}
                      />
                      <button
                        className="finance-button"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            apiClient.lockFinanceCommissionCandidate(
                              latestCandidate.id,
                              lockComment || undefined,
                            ),
                          )
                        }
                      >
                        锁定候选
                      </button>
                    </div>
                  )}

                <div className="finance-history" data-testid="commission-history">
                  {detail.commission_candidates.map((candidate) => (
                    <div className="finance-history-row" key={candidate.id}>
                      <strong>v{candidate.version}</strong>
                      <span className={`finance-badge ${badgeTone(candidate.status)}`}>
                        {candidate.status}
                      </span>
                      <span>{money(candidate.total_commission_rmb)}</span>
                      <span>{candidate.revision_reason ?? candidate.formula_version}</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </section>
  );
}

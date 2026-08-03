import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  AfterSalesApprovalConfig,
  AfterSalesCase,
  AfterSalesCaseStatus,
  ApiError,
  Currency,
  SalesOrderResponse,
  UserSummary,
} from '../lib/types';
import './SamplesAfterSales.css';

const statusLabel: Record<AfterSalesCaseStatus, string> = {
  draft: '草稿',
  pending_approval: '审批中',
  approved: '已批准',
  rejected: '已拒绝',
  executing: '执行中',
  completed: '调整已入账',
  closed: '已关闭',
};

const responsibilityLabel: Record<AfterSalesCase['responsibility'], string> = {
  supplier: '供应商',
  logistics: '物流',
  company: '公司',
  customer: '客户',
  undetermined: '待认定',
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

export function AfterSalesPage() {
  const { user, hasPermission } = useAuth();
  const [cases, setCases] = useState<AfterSalesCase[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [orders, setOrders] = useState<SalesOrderResponse[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [config, setConfig] = useState<AfterSalesApprovalConfig | null>(null);
  const [configApprovers, setConfigApprovers] = useState<string[]>(['', '']);
  const [showCreate, setShowCreate] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [orderId, setOrderId] = useState('');
  const [caseType, setCaseType] = useState<'refund' | 'compensation'>('refund');
  const [responsibility, setResponsibility] =
    useState<AfterSalesCase['responsibility']>('supplier');
  const [reason, setReason] = useState('');
  const [requestedAmount, setRequestedAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('RMB');
  const [proofFile, setProofFile] = useState<File | null>(null);

  const [decisionReason, setDecisionReason] = useState('');
  const [fxRate, setFxRate] = useState('1');
  const [fxSource, setFxSource] = useState('currency_identity');
  const [fxCapturedAt, setFxCapturedAt] = useState(localDateTime);
  const [externalReference, setExternalReference] = useState('');
  const [executionProof, setExecutionProof] = useState<File | null>(null);

  const selected = useMemo(
    () => cases.find((row) => row.id === selectedId) ?? null,
    [cases, selectedId],
  );
  const currentStep = selected?.approval_steps.find((step) => step.status === 'current') ?? null;

  async function loadCases(preferredId?: string) {
    const rows = await apiClient.listAfterSalesCases();
    setCases(rows);
    setSelectedId((current) => preferredId || current || rows[0]?.id || '');
  }

  async function loadConfig() {
    try {
      const next = await apiClient.getAfterSalesApprovalConfig();
      setConfig(next);
      setConfigApprovers(next.steps.map((step) => step.approver_user_id));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'AFTER_SALES_APPROVAL_CONFIG_REQUIRED') {
        setConfig(null);
        return;
      }
      throw caught;
    }
  }

  useEffect(() => {
    void loadCases().catch((caught) => setError(errorMessage(caught)));
    if (hasPermission('after_sales:create')) {
      void apiClient
        .listSalesOrders({ pageSize: 100, status: 'settled' })
        .then((response) => setOrders(response.data))
        .catch((caught) => setError(errorMessage(caught)));
    }
    if (hasPermission('after_sales:approve')) {
      void loadConfig().catch((caught) => setError(errorMessage(caught)));
    }
    if (hasPermission('users:view')) {
      void apiClient
        .listUsers({ pageSize: 100, status: 'active' })
        .then((response) => setUsers(response.data))
        .catch((caught) => setError(errorMessage(caught)));
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    setDecisionReason('');
    setFxRate(selected.currency === 'RMB' ? '1' : '');
    setFxSource(selected.currency === 'RMB' ? 'currency_identity' : '');
    setExternalReference('');
    setExecutionProof(null);
  }, [selected?.id]);

  async function run(action: () => Promise<unknown>, preferredId = selectedId) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadCases(preferredId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createCase(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const uploaded = proofFile
        ? await apiClient.uploadFile(proofFile, 'after_sales_proof')
        : null;
      const created = await apiClient.createAfterSalesCase(orderId, {
        case_type: caseType,
        responsibility,
        reason,
        requested_amount: requestedAmount,
        currency,
        proof_file_id: uploaded?.id,
      });
      setShowCreate(false);
      setReason('');
      setRequestedAmount('');
      setProofFile(null);
      await loadCases(created.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    const approvers = configApprovers.filter(Boolean);
    if (approvers.length < 2 || new Set(approvers).size !== approvers.length) {
      setError('审批流至少需要两名不同的审批人');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await apiClient.replaceAfterSalesApprovalConfig(approvers);
      setConfig(next);
      setConfigApprovers(next.steps.map((step) => step.approver_user_id));
      setShowConfig(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function decide(decision: 'approved' | 'rejected') {
    if (!selected) return;
    if (decision === 'rejected' && !decisionReason.trim()) {
      setError('拒绝售后申请必须填写原因');
      return;
    }
    void run(() =>
      apiClient.decideAfterSalesCase(selected.id, decision, decisionReason.trim() || undefined),
    );
  }

  function execute(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    void run(async () => {
      const uploaded = executionProof
        ? await apiClient.uploadFile(executionProof, 'after_sales_execution_proof')
        : null;
      return apiClient.executeAfterSalesCase(selected.id, {
        amount: selected.requested_amount,
        fx_rate_to_rmb: fxRate,
        fx_source: fxSource,
        fx_captured_at: new Date(fxCapturedAt).toISOString(),
        external_reference: externalReference,
        proof_file_id: uploaded?.id,
      });
    });
  }

  return (
    <section className="ops-workspace">
      <header className="ops-heading">
        <div>
          <h1>售后</h1>
          <p>申请、逐级审批、退款或赔偿调整</p>
        </div>
        <div className="ops-actions">
          {hasPermission('after_sales:approve') && hasPermission('users:view') && (
            <button
              className="ops-button secondary"
              type="button"
              onClick={() => setShowConfig((current) => !current)}
            >
              审批流
            </button>
          )}
          {hasPermission('after_sales:create') && (
            <button
              className="ops-button"
              type="button"
              onClick={() => setShowCreate((current) => !current)}
            >
              {showCreate ? '取消新建' : '新建售后申请'}
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="ops-alert" role="alert">
          {error}
        </div>
      )}

      {showConfig && (
        <form className="ops-create" onSubmit={saveConfig}>
          <div className="ops-section-header">
            <h2>多级审批流</h2>
            <span>{config ? `当前版本 ${config.version}` : '尚未配置'}</span>
          </div>
          <div className="ops-approval-config">
            {configApprovers.map((approverId, index) => (
              <div key={index} className="ops-config-row">
                <span className="ops-step-number">{index + 1}</span>
                <label className="ops-field">
                  审批人
                  <select
                    required
                    aria-label={`第 ${index + 1} 级审批人`}
                    value={approverId}
                    onChange={(event) =>
                      setConfigApprovers((current) =>
                        current.map((value, rowIndex) =>
                          rowIndex === index ? event.target.value : value,
                        ),
                      )
                    }
                  >
                    <option value="">选择审批人</option>
                    {users.map((candidate) => (
                      <option
                        key={candidate.id}
                        value={candidate.id}
                        disabled={configApprovers.some(
                          (value, rowIndex) => rowIndex !== index && value === candidate.id,
                        )}
                      >
                        {candidate.name} · {candidate.email}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="ops-button secondary"
                  type="button"
                  disabled={configApprovers.length <= 2}
                  onClick={() =>
                    setConfigApprovers((current) =>
                      current.filter((_, rowIndex) => rowIndex !== index),
                    )
                  }
                >
                  移除
                </button>
              </div>
            ))}
          </div>
          <div className="ops-actions">
            <button
              className="ops-button secondary"
              type="button"
              disabled={configApprovers.length >= 10}
              onClick={() => setConfigApprovers((current) => [...current, ''])}
            >
              添加审批级别
            </button>
            <button className="ops-button" disabled={busy}>
              发布新版本
            </button>
          </div>
        </form>
      )}

      {showCreate && (
        <form className="ops-create" onSubmit={createCase}>
          <div className="ops-section-header">
            <h2>新售后申请</h2>
            <span>仅显示已结算订单</span>
          </div>
          <div className="ops-form-grid three">
            <label className="ops-field">
              销售订单
              <select required value={orderId} onChange={(event) => setOrderId(event.target.value)}>
                <option value="">选择订单</option>
                {orders.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.order_number} · {order.currency} {order.total_amount}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-field">
              处理类型
              <select
                value={caseType}
                onChange={(event) => setCaseType(event.target.value as 'refund' | 'compensation')}
              >
                <option value="refund">退款</option>
                <option value="compensation">赔偿</option>
              </select>
            </label>
            <label className="ops-field">
              责任归属
              <select
                value={responsibility}
                onChange={(event) =>
                  setResponsibility(event.target.value as AfterSalesCase['responsibility'])
                }
              >
                {Object.entries(responsibilityLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-field">
              申请金额
              <span className="ops-inline-field">
                <input
                  required
                  inputMode="decimal"
                  value={requestedAmount}
                  onChange={(event) => setRequestedAmount(event.target.value)}
                />
                <select
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value as Currency)}
                >
                  {(['RMB', 'USD', 'HKD', 'EUR'] as const).map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </span>
            </label>
            <label className="ops-field wide">
              原因
              <textarea
                required
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="ops-field">
              申请凭证
              <input
                type="file"
                onChange={(event) => setProofFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          <div className="ops-actions">
            <button className="ops-button" disabled={busy || !config}>
              创建草稿
            </button>
            {!config && <span className="ops-muted">需先发布审批流</span>}
          </div>
        </form>
      )}

      <div className="ops-grid">
        <aside className="ops-list" aria-label="售后申请列表">
          <h2>售后记录</h2>
          {cases.length === 0 && <p className="ops-muted">暂无售后申请</p>}
          {cases.map((row) => (
            <button
              key={row.id}
              type="button"
              aria-current={row.id === selectedId}
              onClick={() => setSelectedId(row.id)}
            >
              <strong>{row.case_number}</strong>
              <span>
                {statusLabel[row.status]} · {row.order_number}
              </span>
            </button>
          ))}
        </aside>

        <div className="ops-detail">
          {!selected && <div className="ops-empty">选择一张售后申请查看详情</div>}
          {selected && (
            <>
              <header className="ops-record-header">
                <div>
                  <h2>{selected.case_number}</h2>
                  <p>
                    {selected.order_number} · 创建于 {dateTime(selected.created_at)}
                  </p>
                </div>
                <span className={`ops-badge ${selected.status}`}>
                  {statusLabel[selected.status]}
                </span>
              </header>

              <section className="ops-section">
                <h3>申请事实</h3>
                <dl className="ops-facts">
                  <div>
                    <dt>类型</dt>
                    <dd>{selected.case_type === 'refund' ? '退款' : '赔偿'}</dd>
                  </div>
                  <div>
                    <dt>责任归属</dt>
                    <dd>{responsibilityLabel[selected.responsibility]}</dd>
                  </div>
                  <div>
                    <dt>申请金额</dt>
                    <dd>
                      {selected.currency} {selected.requested_amount}
                    </dd>
                  </div>
                  <div className="wide">
                    <dt>原因</dt>
                    <dd>{selected.reason}</dd>
                  </div>
                  <div>
                    <dt>审批流版本</dt>
                    <dd>v{selected.approval_config.version}</dd>
                  </div>
                </dl>
              </section>

              <section className="ops-section">
                <h3>冻结审批步骤</h3>
                <div className="ops-timeline">
                  {selected.approval_steps.map((step) => {
                    const approver = users.find(
                      (candidate) => candidate.id === step.approver_user_id,
                    );
                    return (
                      <div key={step.id}>
                        <strong>
                          第 {step.step_no} 级 ·{' '}
                          {step.status === 'current'
                            ? '当前待审'
                            : step.status === 'waiting'
                              ? '等待'
                              : step.status === 'approved'
                                ? '已批准'
                                : '已拒绝'}
                        </strong>
                        <span>
                          {approver?.name ?? step.approver_user_id}
                          {step.reason ? ` · ${step.reason}` : ''}
                          {step.decided_at ? ` · ${dateTime(step.decided_at)}` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>

              {selected.adjustment && (
                <section className="ops-section">
                  <div className="ops-section-header">
                    <h3>财务调整流水</h3>
                    <Link to="/finance">查看利润与提成版本</Link>
                  </div>
                  <dl className="ops-facts">
                    <div>
                      <dt>调整金额</dt>
                      <dd>
                        {selected.adjustment.currency} {selected.adjustment.amount}
                      </dd>
                    </div>
                    <div>
                      <dt>人民币金额</dt>
                      <dd>RMB {selected.adjustment.amount_rmb}</dd>
                    </div>
                    <div>
                      <dt>外部凭据号</dt>
                      <dd>{selected.adjustment.external_reference}</dd>
                    </div>
                    <div>
                      <dt>汇率来源</dt>
                      <dd>{selected.adjustment.fx_source}</dd>
                    </div>
                    <div>
                      <dt>执行时间</dt>
                      <dd>{dateTime(selected.adjustment.created_at)}</dd>
                    </div>
                  </dl>
                </section>
              )}

              <section className="ops-section ops-operation">
                <h3>当前操作</h3>
                {selected.status === 'draft' && hasPermission('after_sales:create') && (
                  <div className="ops-actions">
                    <button
                      className="ops-button"
                      disabled={busy}
                      onClick={() => void run(() => apiClient.submitAfterSalesCase(selected.id))}
                    >
                      提交审批
                    </button>
                  </div>
                )}
                {selected.status === 'pending_approval' &&
                  hasPermission('after_sales:approve') &&
                  currentStep?.approver_user_id === user?.id && (
                    <>
                      <label className="ops-field">
                        审批原因
                        <input
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
                          批准本级
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
                {selected.status === 'pending_approval' &&
                  currentStep?.approver_user_id !== user?.id && (
                    <p className="ops-muted">等待当前审批人处理。</p>
                  )}
                {selected.status === 'approved' && hasPermission('after_sales:execute') && (
                  <div className="ops-actions">
                    <button
                      className="ops-button"
                      disabled={busy}
                      onClick={() => void run(() => apiClient.startAfterSalesCase(selected.id))}
                    >
                      开始执行
                    </button>
                  </div>
                )}
                {selected.status === 'executing' && hasPermission('after_sales:execute') && (
                  <form className="ops-form-grid three" onSubmit={execute}>
                    <label className="ops-field">
                      执行金额
                      <input disabled value={`${selected.currency} ${selected.requested_amount}`} />
                    </label>
                    <label className="ops-field">
                      兑人民币汇率
                      <input
                        required
                        inputMode="decimal"
                        value={fxRate}
                        onChange={(event) => setFxRate(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      汇率来源
                      <input
                        required
                        maxLength={120}
                        value={fxSource}
                        onChange={(event) => setFxSource(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      汇率取值时间
                      <input
                        required
                        type="datetime-local"
                        value={fxCapturedAt}
                        onChange={(event) => setFxCapturedAt(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      外部凭据号
                      <input
                        required
                        maxLength={160}
                        value={externalReference}
                        onChange={(event) => setExternalReference(event.target.value)}
                      />
                    </label>
                    <label className="ops-field">
                      执行凭证
                      <input
                        type="file"
                        onChange={(event) => setExecutionProof(event.target.files?.[0] ?? null)}
                      />
                    </label>
                    <div className="ops-actions wide">
                      <button className="ops-button" disabled={busy}>
                        执行并生成财务新版本
                      </button>
                    </div>
                  </form>
                )}
                {selected.status === 'completed' && hasPermission('after_sales:execute') && (
                  <div>
                    <p className="ops-muted">新提成版本锁定后可关闭本售后申请。</p>
                    <div className="ops-actions">
                      <button
                        className="ops-button"
                        disabled={busy}
                        onClick={() => void run(() => apiClient.closeAfterSalesCase(selected.id))}
                      >
                        关闭售后申请
                      </button>
                      <Link className="ops-link-button" to="/finance">
                        前往财务核对
                      </Link>
                    </div>
                  </div>
                )}
                {['rejected', 'closed'].includes(selected.status) && (
                  <p className="ops-muted">该售后申请没有待执行操作。</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

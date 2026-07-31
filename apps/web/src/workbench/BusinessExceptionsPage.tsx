import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  BusinessException,
  BusinessExceptionStatus,
  BusinessExceptionType,
  ExceptionAssignee,
} from '../lib/types';

const TYPE_LABELS: Record<BusinessExceptionType, string> = {
  price_variance: '价差',
  quantity_variance: '数量差',
  quality_variance: '质量差',
  missing_expense: '费用缺失',
  duplicate_customer: '重复客户',
};
const STATUS_LABELS: Record<BusinessExceptionStatus, string> = {
  open: '待分派',
  assigned: '已分派',
  in_progress: '处理中',
  resolved: '待关闭',
  closed: '已关闭',
};

export function BusinessExceptionsPage() {
  const { hasPermission } = useAuth();
  const [type, setType] = useState<BusinessExceptionType | ''>('');
  const [status, setStatus] = useState<BusinessExceptionStatus | ''>('');
  const [rows, setRows] = useState<BusinessException[]>([]);
  const [assignees, setAssignees] = useState<ExceptionAssignee[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await apiClient.listBusinessExceptions({
        type: type || undefined,
        status: status || undefined,
        pageSize: 100,
      });
      setRows(result.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '异常列表加载失败');
    }
  }, [type, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!hasPermission('business_exceptions:assign')) return;
    apiClient
      .listExceptionAssignees()
      .then(setAssignees)
      .catch(() => setAssignees([]));
  }, [hasPermission]);

  async function mutate(id: string, action: () => Promise<BusinessException>) {
    setBusy(id);
    setError(null);
    try {
      const updated = await action();
      setRows((current) => current.map((row) => (row.id === id ? updated : row)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败，请刷新后重试');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ maxWidth: 1180 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>业务异常</h1>
      <p style={{ color: '#64748b' }}>
        价差、数量差、费用缺失和重复客户按服务端状态机分派、处理与关闭。
      </p>
      <div style={{ display: 'flex', gap: 12, margin: '18px 0' }}>
        <label>
          类型
          <select
            value={type}
            onChange={(event) => setType(event.target.value as BusinessExceptionType | '')}
          >
            <option value="">全部</option>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as BusinessExceptionStatus | '')}
          >
            <option value="">全部</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {rows.length === 0 ? (
        <p style={{ color: '#64748b' }}>当前范围内没有异常。</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {rows.map((row) => (
            <article
              key={row.id}
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: 16,
                background: 'white',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                <div>
                  <strong>{TYPE_LABELS[row.type]}</strong>
                  <span
                    style={{
                      marginLeft: 8,
                      color: row.severity === 'critical' ? '#be123c' : '#64748b',
                    }}
                  >
                    {row.severity}
                  </span>
                  <div style={{ marginTop: 7 }}>{row.summary}</div>
                  <div style={{ color: '#64748b', fontSize: 12, marginTop: 5 }}>
                    {row.contextType} · {row.contextId} · v{row.version}
                  </div>
                </div>
                <strong>{STATUS_LABELS[row.status]}</strong>
              </div>
              {row.assigneeName && <p style={{ fontSize: 13 }}>负责人：{row.assigneeName}</p>}
              {row.resolution && <p style={{ fontSize: 13 }}>处理结论：{row.resolution}</p>}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                  marginTop: 12,
                }}
              >
                {hasPermission('business_exceptions:assign') &&
                  (row.status === 'open' || row.status === 'assigned') && (
                    <>
                      <select
                        aria-label={`分派 ${row.summary}`}
                        value={selectedAssignee[row.id] ?? row.assignedToUserId ?? ''}
                        onChange={(event) =>
                          setSelectedAssignee((current) => ({
                            ...current,
                            [row.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="">选择负责人</option>
                        {assignees.map((assignee) => (
                          <option key={assignee.id} value={assignee.id}>
                            {assignee.name}（{assignee.email}）
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={
                          busy === row.id || !(selectedAssignee[row.id] ?? row.assignedToUserId)
                        }
                        onClick={() =>
                          void mutate(row.id, () =>
                            apiClient.assignBusinessException(
                              row.id,
                              selectedAssignee[row.id] ?? row.assignedToUserId!,
                              row.version,
                            ),
                          )
                        }
                      >
                        分派
                      </button>
                    </>
                  )}
                {hasPermission('business_exceptions:resolve') && row.status === 'assigned' && (
                  <button
                    disabled={busy === row.id}
                    onClick={() =>
                      void mutate(row.id, () =>
                        apiClient.startBusinessException(row.id, row.version),
                      )
                    }
                  >
                    开始处理
                  </button>
                )}
                {hasPermission('business_exceptions:resolve') && row.status === 'in_progress' && (
                  <>
                    <input
                      aria-label={`处理结论 ${row.summary}`}
                      placeholder="填写处理结论"
                      value={resolutions[row.id] ?? ''}
                      onChange={(event) =>
                        setResolutions((current) => ({ ...current, [row.id]: event.target.value }))
                      }
                    />
                    <button
                      disabled={busy === row.id || !(resolutions[row.id] ?? '').trim()}
                      onClick={() =>
                        void mutate(row.id, () =>
                          apiClient.resolveBusinessException(
                            row.id,
                            resolutions[row.id],
                            row.version,
                          ),
                        )
                      }
                    >
                      标记已处理
                    </button>
                  </>
                )}
                {hasPermission('business_exceptions:close') && row.status === 'resolved' && (
                  <button
                    disabled={busy === row.id}
                    onClick={() =>
                      void mutate(row.id, () =>
                        apiClient.closeBusinessException(row.id, row.version),
                      )
                    }
                  >
                    关闭异常
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

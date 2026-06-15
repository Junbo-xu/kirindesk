import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CommissionTable } from '../lib/types';
import { formatRate } from './format';
import { td, tdNum, th, thNum } from './styles';

const STATUS_LABELS: Record<CommissionTable['status'], string> = {
  active: '启用',
  archived: '归档',
};

export function CommissionTablesListPage() {
  const [tables, setTables] = useState<CommissionTable[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const res = await apiClient.commissionTables();
      setTables(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 403) {
        setForbidden(true);
        setTables(null);
      } else {
        setError(err instanceof ApiError ? err.message : '加载提成规则失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 820 }}>
      <h1 style={{ fontSize: 20 }}>提成规则</h1>
      <p style={{ fontSize: 13 }}>
        <Link to="/commission">提成汇总</Link> · <Link to="/commission/orders">提成明细</Link> ·{' '}
        <Link to="/commission/settlements">结算单</Link> ·{' '}
        <Link to="/commission/payouts">发放单</Link>
      </p>

      {/* The "新建/编辑" controls are always offered; the server is the gate —
          a user without commission_tables:lock gets a graceful 403 on save. */}
      {!forbidden && (
        <p>
          <Link to="/commission/tables/new">+ 新建提成规则表</Link>
        </p>
      )}

      {forbidden && <p style={{ color: 'crimson' }}>没有权限查看提成规则</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && <p style={{ color: '#888' }}>加载中…</p>}

      {!forbidden && tables && tables.length === 0 && (
        <p style={{ color: '#888' }}>还没有提成规则表。</p>
      )}

      {!forbidden && tables && tables.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>名称</th>
              <th style={thNum}>默认费率</th>
              <th style={th}>状态</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id}>
                <td style={td}>{t.name}</td>
                <td style={tdNum}>{formatRate(t.default_rate)}</td>
                <td style={td}>{STATUS_LABELS[t.status]}</td>
                <td style={td}>
                  <Link to={`/commission/tables/${t.id}`}>编辑</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

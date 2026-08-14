import { FormEvent, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import { ApiError, CustomsDeclaration, CustomsDeclarationInput } from '../lib/types';

type Details = Omit<CustomsDeclarationInput, 'idempotency_key'>;
type OrderOption = { id: string; label: string };

const EMPTY_DETAILS: Details = {
  port: '',
  trade_mode: '',
  package_type: '',
  gross_weight_kg: '',
  consignor_name: '',
  consignor_uscc: '',
  consignor_contact: '',
  consignor_phone: '',
  customs_broker_name: '',
  customs_broker_uscc: '',
  customs_broker_contact: '',
  customs_broker_phone: '',
  authorization_matters: ['代理申报、配合查验及办理放行手续'],
};

function message(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作失败，请稍后重试';
  const missing = Array.isArray(error.details?.missing) ? error.details.missing : [];
  const conflicts = Array.isArray(error.details?.conflicts) ? error.details.conflicts : [];
  const issues = [...missing, ...conflicts]
    .map((item) =>
      item && typeof item === 'object' && 'code' in item ? String(item.code) : String(item),
    )
    .join('、');
  return issues ? `${error.message}：${issues}` : error.message;
}

function shouldRetainOperation(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

function detailsFromDeclaration(declaration: CustomsDeclaration): Details {
  const data = declaration.customs_data;
  return {
    port: data.port,
    trade_mode: data.trade_mode,
    package_type: data.package_type,
    gross_weight_kg: data.gross_weight_kg,
    consignor_name: data.consignor.name,
    consignor_uscc: data.consignor.uscc,
    consignor_contact: data.consignor.contact,
    consignor_phone: data.consignor.phone,
    customs_broker_name: data.customs_broker.name,
    customs_broker_uscc: data.customs_broker.uscc,
    customs_broker_contact: data.customs_broker.contact,
    customs_broker_phone: data.customs_broker.phone,
    authorization_matters: data.authorization_matters,
  };
}

export function CustomsDeclarationsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('customs_declarations:manage');
  const canExport = hasPermission('customs_declarations:export');
  const canBrowseOrders = canManage && hasPermission('orders:view');
  const [orderOptions, setOrderOptions] = useState<OrderOption[]>([]);
  const [orderId, setOrderId] = useState('');
  const [declaration, setDeclaration] = useState<CustomsDeclaration | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [loadingDeclaration, setLoadingDeclaration] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saveKey = useRef<string | null>(null);
  const generateKey = useRef<string | null>(null);
  const exportKeys = useRef<Record<number, string>>({});
  const loadSequence = useRef(0);

  async function loadDeclaration(selectedOrderId: string) {
    const sequence = ++loadSequence.current;
    setLoadingDeclaration(true);
    if (!selectedOrderId) {
      if (sequence === loadSequence.current) {
        setDeclaration(null);
        setDetails(EMPTY_DETAILS);
        setLoadingDeclaration(false);
      }
      return;
    }
    try {
      const loaded = await apiClient.getCustomsDeclaration(selectedOrderId);
      if (sequence === loadSequence.current) {
        setDeclaration(loaded);
        setDetails(detailsFromDeclaration(loaded));
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        if (sequence === loadSequence.current) {
          setDeclaration(null);
          setDetails(EMPTY_DETAILS);
        }
        return;
      }
      throw caught;
    } finally {
      if (sequence === loadSequence.current) setLoadingDeclaration(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiClient.listCustomsDeclarations(),
      canBrowseOrders ? apiClient.listSalesOrders({ pageSize: 100 }) : Promise.resolve(null),
    ])
      .then(async ([existing, salesOrders]) => {
        if (cancelled) return;
        const options = new Map<string, OrderOption>();
        for (const item of existing.data) {
          options.set(item.sales_order_id, {
            id: item.sales_order_id,
            label: `${item.customs_data.order_number} · ${item.customs_data.currency} ${item.customs_data.total_amount}`,
          });
        }
        for (const order of salesOrders?.data ?? []) {
          if (!order.fulfillment_locked_at || options.has(order.id)) continue;
          options.set(order.id, {
            id: order.id,
            label: `${order.order_number} · ${order.currency} ${order.total_amount}`,
          });
        }
        const available = [...options.values()];
        setOrderOptions(available);
        const first = available[0]?.id ?? '';
        setOrderId(first);
        await loadDeclaration(first);
      })
      .catch((caught) => {
        if (!cancelled) setError(message(caught));
      });
    return () => {
      cancelled = true;
      loadSequence.current += 1;
    };
  }, [canBrowseOrders]);

  function field(key: keyof Details, value: string) {
    setDetails((current) => ({ ...current, [key]: value }));
    saveKey.current = null;
  }

  async function selectOrder(id: string) {
    setOrderId(id);
    setError(null);
    setNotice(null);
    saveKey.current = null;
    generateKey.current = null;
    exportKeys.current = {};
    try {
      await loadDeclaration(id);
    } catch (caught) {
      setError(message(caught));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!orderId || !canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    saveKey.current ??= `customs-save:${orderId}:${crypto.randomUUID()}`;
    const input = { ...details, idempotency_key: saveKey.current };
    try {
      if (declaration) {
        const result = await apiClient.refreshCustomsDeclaration(declaration.id, input);
        setDeclaration(result.declaration);
        setDetails(detailsFromDeclaration(result.declaration));
        setNotice(
          result.refreshed
            ? `来源已刷新，保留 ${result.preserved_version_count} 个历史版本`
            : '来源与填写内容未变化，未创建覆盖版本',
        );
      } else {
        const result = await apiClient.createCustomsDeclaration(orderId, input);
        setDeclaration(result.declaration);
        setDetails(detailsFromDeclaration(result.declaration));
        setNotice('报关资料草稿已创建');
      }
      saveKey.current = null;
    } catch (caught) {
      setError(message(caught));
      if (!shouldRetainOperation(caught)) saveKey.current = null;
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!declaration || !canManage) return;
    setBusy(true);
    setError(null);
    generateKey.current ??= `customs-generate:${declaration.id}:${crypto.randomUUID()}`;
    try {
      const result = await apiClient.generateCustomsDeclaration(
        declaration.id,
        generateKey.current,
      );
      await loadDeclaration(orderId);
      setNotice(`归档版本 v${result.version.version} 已生成，两份 PDF 已进入 Files`);
      generateKey.current = null;
    } catch (caught) {
      setError(message(caught));
      if (!shouldRetainOperation(caught)) generateKey.current = null;
    } finally {
      setBusy(false);
    }
  }

  async function exportVersion(version: number) {
    if (!declaration || !canExport) return;
    setBusy(true);
    setError(null);
    exportKeys.current[version] ??=
      `customs-export:${declaration.id}:${version}:${crypto.randomUUID()}`;
    try {
      await apiClient.exportCustomsDeclarationVersion(
        declaration.id,
        version,
        exportKeys.current[version],
      );
      setNotice(`版本 v${version} 导出已记录，可分别下载两份归档 PDF`);
      delete exportKeys.current[version];
    } catch (caught) {
      setError(message(caught));
      if (!shouldRetainOperation(caught)) delete exportKeys.current[version];
    } finally {
      setBusy(false);
    }
  }

  async function download(version: number, documentType: 'pre_entry' | 'authorization') {
    if (!declaration || !canExport) return;
    try {
      window.location.href = await apiClient.getCustomsDeclarationDownloadUrl(
        declaration.id,
        version,
        documentType,
      );
    } catch (caught) {
      setError(message(caught));
    }
  }

  const input = (label: string, key: keyof Details, placeholder = '') => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span>{label}</span>
      <input
        aria-label={label}
        value={String(details[key])}
        placeholder={placeholder}
        onChange={(event) => field(key, event.target.value)}
        disabled={loadingDeclaration || !canManage}
        required
      />
    </label>
  );

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <header>
        <h1 style={{ marginBottom: 6 }}>报关资料与版本归档</h1>
        <p style={{ color: '#64748b', margin: 0 }}>
          仅从已审批、已锁定订单及同版本的 CI/PL 历史导出生成；不一致会阻断归档。
        </p>
      </header>

      <label style={{ display: 'grid', gap: 4, maxWidth: 520 }}>
        <span>锁定销售订单</span>
        <select
          aria-label="锁定销售订单"
          value={orderId}
          onChange={(event) => void selectOrder(event.target.value)}
        >
          <option value="">请选择</option>
          {orderOptions.map((order) => (
            <option key={order.id} value={order.id}>
              {order.label}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <div role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={{ color: '#166534' }}>
          {notice}
        </div>
      )}
      {loadingDeclaration && <p>正在读取报关来源…</p>}
      {orderOptions.length === 0 && (
        <p>
          {canBrowseOrders
            ? '暂无已锁定订单。请先完成订单锁定、CI/PL 锁定并导出。'
            : '暂无可查看的报关资料；从锁定订单新建还需要订单查看权限。'}
        </p>
      )}

      {orderId && (
        <form onSubmit={save} style={{ display: 'grid', gap: 14 }}>
          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {input('申报口岸', 'port', '上海海关')}
            {input('贸易方式', 'trade_mode', '一般贸易')}
            {input('包装种类', 'package_type', '纸箱')}
            {input('毛重（kg）', 'gross_weight_kg', '100.0000')}
          </section>
          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {input('委托方名称', 'consignor_name')}
            {input('委托方统一社会信用代码', 'consignor_uscc')}
            {input('委托方联系人', 'consignor_contact')}
            {input('委托方联系电话', 'consignor_phone')}
            {input('报关行名称', 'customs_broker_name')}
            {input('报关行统一社会信用代码', 'customs_broker_uscc')}
            {input('报关行联系人', 'customs_broker_contact')}
            {input('报关行联系电话', 'customs_broker_phone')}
          </section>
          <label style={{ display: 'grid', gap: 4 }}>
            <span>授权事项（每行一项）</span>
            <textarea
              aria-label="授权事项"
              rows={4}
              value={details.authorization_matters.join('\n')}
              onChange={(event) => {
                setDetails((current) => ({
                  ...current,
                  authorization_matters: event.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                }));
                saveKey.current = null;
              }}
              disabled={loadingDeclaration || !canManage}
              required
            />
          </label>
          {canManage && (
            <div>
              <button type="submit" disabled={busy || loadingDeclaration}>
                {declaration ? '刷新报关资料' : '创建报关资料'}
              </button>{' '}
              {declaration && (
                <button
                  type="button"
                  disabled={busy || loadingDeclaration}
                  onClick={() => void generate()}
                >
                  生成并归档两份 PDF
                </button>
              )}
            </div>
          )}
        </form>
      )}

      {declaration && (
        <section style={{ display: 'grid', gap: 12 }}>
          <h2>来源与归档</h2>
          <div>
            草稿修订 r{declaration.draft_revision} · CI v{declaration.source.ci.source_version}/e
            {declaration.source.ci.export_version} · PL v{declaration.source.pl.source_version}/e
            {declaration.source.pl.export_version} · 指纹{' '}
            {declaration.source.fingerprint.slice(0, 12)}…
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>版本</th>
                <th style={{ textAlign: 'left' }}>生成时间</th>
                <th style={{ textAlign: 'left' }}>文件与操作</th>
              </tr>
            </thead>
            <tbody>
              {declaration.versions.map((version) => (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td>{new Date(version.generated_at).toLocaleString()}</td>
                  <td>
                    {canExport ? (
                      <>
                        <button disabled={busy} onClick={() => void exportVersion(version.version)}>
                          记录导出
                        </button>{' '}
                        <button onClick={() => void download(version.version, 'pre_entry')}>
                          下载预录单
                        </button>{' '}
                        <button onClick={() => void download(version.version, 'authorization')}>
                          下载委托书
                        </button>
                      </>
                    ) : (
                      <span>无导出权限</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

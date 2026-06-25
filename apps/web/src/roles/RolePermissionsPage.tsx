import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CatalogModule,
  DataScope,
  DATA_SCOPE_LABELS,
  PermissionGrantInput,
} from '../lib/types';

// data_scope choices the matrix offers per the plan (all / own). If an existing
// grant already uses 'assigned', that option is added so it round-trips.
const SCOPE_OPTIONS: DataScope[] = ['all', 'own'];

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function RolePermissionsPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSystem, setIsSystem] = useState(false);
  const [catalog, setCatalog] = useState<CatalogModule[]>([]);
  // permissionId -> selected data_scope. Absence = not granted.
  const [grants, setGrants] = useState<Record<string, DataScope>>({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const catalogP = apiClient.listPermissionCatalog();
    const roleP = id ? apiClient.getRole(id) : Promise.resolve(null);
    Promise.all([catalogP, roleP])
      .then(([cat, role]) => {
        if (!active) return;
        setCatalog(cat);
        if (role) {
          setName(role.name);
          setDescription(role.description ?? '');
          setIsSystem(role.isSystem);
          const next: Record<string, DataScope> = {};
          for (const g of role.permissions) {
            next[g.permissionId] = g.dataScope as DataScope;
          }
          setGrants(next);
        }
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 404) setError('角色不存在');
        else if (s === 403) setError('没有权限查看角色');
        else setError(err instanceof ApiError ? err.message : '加载失败，请稍后重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  function mapError(err: unknown) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 400) {
      setError(err instanceof ApiError ? err.message : '提交数据有误');
      setFieldErrors(err instanceof ApiError ? (err.fields ?? null) : null);
    } else if (status === 403) {
      // System-role read-only, or subset/privilege-escalation denial.
      setError(err instanceof ApiError ? err.message : '没有权限或越权授权被拒绝');
    } else if (status === 404) {
      setError('角色不存在');
    } else if (status === 409) {
      // Duplicate name, or role still referenced by users.
      setError(err instanceof ApiError ? err.message : '操作被拒绝');
    } else {
      setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  function togglePermission(permissionId: string, checked: boolean) {
    setGrants((prev) => {
      const next = { ...prev };
      if (checked) next[permissionId] = 'all';
      else delete next[permissionId];
      return next;
    });
  }

  function setScope(permissionId: string, scope: DataScope) {
    setGrants((prev) => ({ ...prev, [permissionId]: scope }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (isSystem) return; // read-only; the save button is hidden anyway
    setError(null);
    setFieldErrors(null);

    if (name.trim() === '') {
      setError('请填写名称');
      return;
    }

    const permissions: PermissionGrantInput[] = Object.entries(grants).map(
      ([permissionId, dataScope]) => ({ permissionId, dataScope }),
    );

    setSubmitting(true);
    try {
      if (isEdit && id) {
        await apiClient.updateRole(id, { name: name.trim(), description: optional(description) });
        await apiClient.setRolePermissions(id, permissions);
      } else {
        const created = await apiClient.createRole({
          name: name.trim(),
          description: optional(description),
        });
        if (permissions.length > 0) {
          await apiClient.setRolePermissions(created.id, permissions);
        }
      }
      navigate('/roles');
    } catch (err) {
      mapError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const label: CSSProperties = { display: 'block', margin: '10px 0' };
  const input: CSSProperties = { display: 'block', marginTop: 2, width: 360, maxWidth: '100%' };

  if (loading) return <p style={{ fontFamily: 'system-ui', color: '#888' }}>加载中…</p>;

  const title = isEdit ? (isSystem ? '查看角色（系统角色只读）' : '编辑角色') : '新建角色';

  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 720 }}>
      <h1 style={{ fontSize: 20 }}>{title}</h1>

      {isSystem && <p style={{ color: '#a60' }}>系统角色不可修改名称、描述或权限，仅供查看。</p>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {fieldErrors && fieldErrors.length > 0 && (
        <ul style={{ color: 'crimson' }}>
          {fieldErrors.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit}>
        <label style={label}>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSystem}
            maxLength={100}
            style={input}
          />
        </label>
        <label style={label}>
          描述（选填）
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isSystem}
            maxLength={500}
            style={input}
          />
        </label>

        <h2 style={{ fontSize: 16, marginTop: 20 }}>权限矩阵</h2>
        {catalog.length === 0 ? (
          <p style={{ color: '#888' }}>没有可用权限。</p>
        ) : (
          catalog.map((mod) => (
            <fieldset
              key={mod.code}
              style={{ border: '1px solid #ddd', padding: 12, margin: '10px 0' }}
            >
              <legend>
                {mod.name} <span style={{ color: '#888' }}>({mod.code})</span>
              </legend>
              {mod.permissions.map((p) => {
                const scope = grants[p.id];
                const checked = scope !== undefined;
                // Preserve a legacy 'assigned' scope as a selectable option.
                const scopeOptions =
                  scope && !SCOPE_OPTIONS.includes(scope)
                    ? [...SCOPE_OPTIONS, scope]
                    : SCOPE_OPTIONS;
                return (
                  <div
                    key={p.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}
                  >
                    <label style={{ flex: 1 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSystem}
                        onChange={(e) => togglePermission(p.id, e.target.checked)}
                      />{' '}
                      {p.name} <span style={{ color: '#888' }}>({p.code})</span>
                    </label>
                    {checked && (
                      <select
                        value={scope}
                        disabled={isSystem}
                        onChange={(e) => setScope(p.id, e.target.value as DataScope)}
                      >
                        {scopeOptions.map((s) => (
                          <option key={s} value={s}>
                            {DATA_SCOPE_LABELS[s] ?? s}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 12 }}>
          {!isSystem && (
            <button type="submit" disabled={submitting}>
              {submitting ? '保存中…' : '保存'}
            </button>
          )}
          <button type="button" onClick={() => navigate('/roles')}>
            {isSystem ? '返回' : '取消'}
          </button>
        </div>
      </form>
    </div>
  );
}

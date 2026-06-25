import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, CreateUserInput, RoleSummary, UpdateUserInput, UserStatus } from '../lib/types';

const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'active', label: '启用' },
  { value: 'inactive', label: '停用' },
];

// Trims a free-text field and returns undefined when empty, so optional fields
// are omitted from the request rather than sent as blank strings.
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function UserFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<UserStatus>('active');
  // Role assignment: the tenant's full role list + the user's selected ids.
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    // Load the role catalog (for checkboxes) and, when editing, the user.
    const rolesP = apiClient.listRoles();
    const userP = id ? apiClient.getUser(id) : Promise.resolve(null);
    Promise.all([rolesP, userP])
      .then(([roleList, user]) => {
        if (!active) return;
        setRoles(roleList);
        if (user) {
          setEmail(user.email);
          setName(user.name);
          setPhone(user.phone ?? '');
          setStatus(user.status);
          setSelectedRoleIds(user.roles.map((r) => r.id));
        }
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 404) setError('用户不存在或已被删除');
        else if (s === 403) setError('没有权限执行该操作');
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
      // Subset guard / privilege-escalation denial, or missing permission.
      setError(err instanceof ApiError ? err.message : '没有权限执行该操作');
    } else if (status === 404) {
      setError('用户不存在或已被删除');
    } else if (status === 409) {
      // Duplicate email, last-owner, or self-lock guard.
      setError(err instanceof ApiError ? err.message : '操作被拒绝');
    } else {
      setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  function toggleRole(roleId: string, checked: boolean) {
    setSelectedRoleIds((prev) =>
      checked ? [...prev, roleId] : prev.filter((rid) => rid !== roleId),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors(null);

    if (name.trim() === '') {
      setError('请填写姓名');
      return;
    }
    if (!isEdit) {
      if (email.trim() === '') {
        setError('请填写邮箱');
        return;
      }
      if (password.length < 8) {
        setError('初始密码至少 8 位');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (isEdit && id) {
        const body: UpdateUserInput = {
          name: name.trim(),
          phone: optional(phone),
          status,
        };
        await apiClient.updateUser(id, body);
        // Full-replace the role set (server enforces the subset guard).
        await apiClient.setUserRoles(id, selectedRoleIds);
      } else {
        const body: CreateUserInput = {
          email: email.trim(),
          name: name.trim(),
          password,
        };
        const tel = optional(phone);
        if (tel) body.phone = tel;
        if (selectedRoleIds.length > 0) body.roleIds = selectedRoleIds;
        await apiClient.createUser(body);
      }
      navigate('/users');
    } catch (err) {
      mapError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle: CSSProperties = { display: 'block', marginTop: 12 };

  if (loading) {
    return <p style={{ fontFamily: 'system-ui' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 480, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>{isEdit ? '编辑用户' : '新建用户'}</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          邮箱
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // Email is the login identity; not editable after creation.
            disabled={isEdit}
            required={!isEdit}
            maxLength={255}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          姓名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            style={{ width: '100%' }}
          />
        </label>
        {!isEdit && (
          <label style={labelStyle}>
            初始密码（至少 8 位）
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              maxLength={200}
              style={{ width: '100%' }}
            />
          </label>
        )}
        <label style={labelStyle}>
          电话（选填）
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={50}
            style={{ width: '100%' }}
          />
        </label>
        {isEdit && (
          <label style={labelStyle}>
            状态
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as UserStatus)}
              style={{ width: '100%' }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <fieldset style={{ marginTop: 16, border: '1px solid #ddd', padding: 12 }}>
          <legend>角色分配</legend>
          {roles.length === 0 ? (
            <p style={{ color: '#888', margin: 0 }}>本租户暂无角色，请先在「角色」中创建。</p>
          ) : (
            roles.map((r) => (
              <label key={r.id} style={{ display: 'block', margin: '4px 0' }}>
                <input
                  type="checkbox"
                  checked={selectedRoleIds.includes(r.id)}
                  onChange={(e) => toggleRole(r.id, e.target.checked)}
                />{' '}
                {r.name}
                {r.isSystem && <span style={{ color: '#888' }}>（系统）</span>}
              </label>
            ))
          )}
        </fieldset>

        {error && <p style={{ color: 'crimson', marginTop: 12 }}>{error}</p>}
        {fieldErrors && fieldErrors.length > 0 && (
          <ul style={{ color: 'crimson' }}>
            {fieldErrors.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button type="submit" disabled={submitting}>
            {submitting ? '提交中…' : isEdit ? '保存' : '创建'}
          </button>
          <button type="button" onClick={() => navigate('/users')}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

import { FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { apiClient } from '../lib/api-client';
import { ApiError, SignupResult } from '../lib/types';

// Phase 2B: anonymous tenant self-service registration. Public page (no auth).
// Fills the signup form → POST /api/auth/signup → on success shows a confirmation
// that guides the new owner to the login page (slug prefilled via query string).
// The password only ever lives in component state; it is cleared on success.
export function SignupPage() {
  const { status } = useAuth();
  const navigate = useNavigate();

  const [tenantName, setTenantName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SignupResult | null>(null);

  if (status === 'authed') return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiClient.signup({
        tenantName,
        slug,
        ownerName,
        ownerEmail,
        ownerPassword,
        contactPhone: contactPhone.trim() || undefined,
      });
      // Clear the password from state immediately on success.
      setOwnerPassword('');
      setResult(res);
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      if (s === 409) {
        // Conflict: slug or owner email already taken. Surface the server message.
        setError(err instanceof ApiError ? err.message : '该租户标识或邮箱已被占用');
      } else if (s === 400) {
        setError(err instanceof ApiError ? err.message : '请检查填写的内容是否正确');
      } else if (s === 429) {
        setError('注册过于频繁，请稍后再试');
      } else {
        setError('注册失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success state: guide to login ────────────────────────────────────────
  if (result) {
    return (
      <div style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 20 }}>注册成功 🎉</h1>
        <p style={{ marginTop: 12 }}>
          租户 <strong>{result.tenant.name}</strong>（标识 <code>{result.tenant.slug}</code>）
          已创建，管理员账号为 <strong>{result.owner.email}</strong>。
        </p>
        <p style={{ marginTop: 12, color: '#555' }}>
          请使用刚才设置的密码登录。登录时需要填写租户标识。
        </p>
        <button
          type="button"
          onClick={() =>
            navigate(`/login?tenantSlug=${encodeURIComponent(result.tenant.slug)}`, {
              replace: true,
            })
          }
          style={{ marginTop: 16 }}
        >
          前往登录
        </button>
      </div>
    );
  }

  // ── Registration form ────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 360, margin: '64px auto', fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>注册 KirinDesk</h1>
      <p style={{ marginTop: 4, color: '#666', fontSize: 13 }}>
        创建一个新的租户。注册后默认使用免费版套餐。
      </p>
      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginTop: 12 }}>
          公司 / 租户名称
          <input
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            required
            maxLength={200}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          租户标识 (tenant slug)
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            placeholder="例如 acme-co（小写字母、数字、连字符）"
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            title="只允许小写字母、数字和连字符，且不能以连字符开头或结尾"
            maxLength={100}
            style={{ width: '100%' }}
          />
          <span style={{ display: 'block', fontSize: 12, color: '#888' }}>
            登录时需要用到，注册后不可更改。
          </span>
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          管理员姓名
          <input
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            required
            maxLength={100}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          管理员邮箱
          <input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            required
            autoComplete="email"
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          密码
          <input
            type="password"
            value={ownerPassword}
            onChange={(e) => setOwnerPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
          <span style={{ display: 'block', fontSize: 12, color: '#888' }}>至少 8 个字符。</span>
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          联系电话（可选）
          <input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            maxLength={50}
            style={{ width: '100%' }}
          />
        </label>
        {error && <p style={{ color: 'crimson', marginTop: 12 }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ marginTop: 16 }}>
          {submitting ? '注册中…' : '注册'}
        </button>
      </form>
      <p style={{ marginTop: 16, fontSize: 13 }}>
        已有账号？<Link to="/login">前往登录</Link>
      </p>
    </div>
  );
}

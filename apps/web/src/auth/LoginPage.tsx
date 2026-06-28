import { FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { ApiError } from '../lib/types';

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Prefilled from ?tenantSlug=… (e.g. right after self-service signup).
  const [tenantSlug, setTenantSlug] = useState(searchParams.get('tenantSlug') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authed') return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password, tenantSlug);
      navigate('/', { replace: true });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 400 || status === 401 ? '邮箱、密码或租户错误' : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>KirinDesk 登录</h1>
      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginTop: 12 }}>
          租户标识 (tenant slug)
          <input
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          邮箱
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 12 }}>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%' }}
          />
        </label>
        {error && <p style={{ color: 'crimson', marginTop: 12 }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ marginTop: 16 }}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
      <p style={{ marginTop: 16, fontSize: 13 }}>
        还没有账号？<Link to="/signup">注册新租户</Link>
      </p>
    </div>
  );
}

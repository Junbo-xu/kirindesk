import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { usePlatformAuth } from './PlatformAuthContext';
import { ApiError } from '../lib/types';

// Platform login (plan §5.3). Email + password only — NO tenant slug (platform
// identity is global). On success the token lands under kd_platform_token.
export function PlatformLoginPage() {
  const { status, login } = usePlatformAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authed') return <Navigate to="/platform/support-grants" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/platform/support-grants', { replace: true });
    } catch (err) {
      const s = err instanceof ApiError ? err.status : 0;
      setError(s === 400 || s === 401 ? '邮箱或密码错误' : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 320, margin: '80px auto', fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>平台控制台登录</h1>
      <form onSubmit={onSubmit}>
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
    </div>
  );
}

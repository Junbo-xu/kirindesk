import { Link, Outlet } from 'react-router-dom';
import { usePlatformAuth } from './PlatformAuthContext';

// Minimal platform-console shell (plan §5.3/§5.5). Deliberately NOT the tenant
// AppLayout — a distinct header makes it visually obvious which identity you are
// operating as. Nav is intentionally narrow: only support-access surfaces.
export function PlatformLayout() {
  const { admin, logout } = usePlatformAuth();
  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 24px',
          borderBottom: '1px solid #ddd',
          background: '#1f2933',
          color: '#fff',
        }}
      >
        <strong>KirinDesk · 平台控制台</strong>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link to="/platform/support-grants" style={{ color: '#cfe' }}>
            我的授权
          </Link>
          <span style={{ color: '#bbb' }}>{admin?.email}</span>
          <button onClick={() => logout()}>登出</button>
        </span>
      </header>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}

import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { visibleNavigation } from './navigation';

export function AppLayout() {
  const { user, logout } = useAuth();
  const groups = visibleNavigation(user?.permissions ?? {});
  return (
    <div style={{ fontFamily: 'system-ui', minHeight: '100vh', background: '#f8fafc' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 24px',
          borderBottom: '1px solid #e2e8f0',
          background: '#0f172a',
          color: 'white',
        }}
      >
        <strong style={{ letterSpacing: 0.3 }}>KirinDesk</strong>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: '#cbd5e1', fontSize: 13 }}>{user?.email}</span>
          <button onClick={() => logout()}>登出</button>
        </span>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)' }}>
        <nav
          aria-label="主导航"
          style={{ padding: '20px 14px', borderRight: '1px solid #e2e8f0', background: 'white' }}
        >
          {groups.map((group) => (
            <section key={group.label} style={{ marginBottom: 22 }}>
              <div
                style={{
                  padding: '0 10px 7px',
                  color: '#64748b',
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                {group.label}
              </div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  style={({ isActive }) => ({
                    display: 'block',
                    padding: '8px 10px',
                    borderRadius: 7,
                    color: isActive ? '#0f172a' : '#475569',
                    background: isActive ? '#e2e8f0' : 'transparent',
                    textDecoration: 'none',
                    fontWeight: isActive ? 650 : 450,
                  })}
                >
                  {item.label}
                </NavLink>
              ))}
            </section>
          ))}
        </nav>
        <main style={{ padding: 28, minWidth: 0 }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

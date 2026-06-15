import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function AppLayout() {
  const { user, logout } = useAuth();
  return (
    <div style={{ fontFamily: 'system-ui' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 24px',
          borderBottom: '1px solid #ddd',
        }}
      >
        <strong>KirinDesk</strong>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link to="/customers">客户</Link>
          <Link to="/suppliers">供应商</Link>
          <Link to="/orders">销售订单</Link>
          <Link to="/purchase-orders">采购订单</Link>
          <Link to="/files">文件</Link>
          <Link to="/reports">报表</Link>
          <Link to="/commission">提成</Link>
          <Link to="/settings">设置</Link>
          <span style={{ color: '#555' }}>{user?.email}</span>
          <button onClick={() => logout()}>登出</button>
        </span>
      </header>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}

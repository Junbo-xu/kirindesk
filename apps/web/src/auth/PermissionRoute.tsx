import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function PermissionRoute({ permission, anyOf }: { permission?: string; anyOf?: string[] }) {
  const { status, hasPermission, hasAnyPermission } = useAuth();
  if (status === 'loading') return <div style={{ padding: 24 }}>加载中…</div>;
  if (status === 'anon') return <Navigate to="/login" replace />;
  const allowed = permission ? hasPermission(permission) : anyOf ? hasAnyPermission(anyOf) : false;
  return allowed ? <Outlet /> : <Navigate to="/forbidden" replace />;
}

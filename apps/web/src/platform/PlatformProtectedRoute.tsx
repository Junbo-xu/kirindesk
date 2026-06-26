import { Navigate, Outlet } from 'react-router-dom';
import { usePlatformAuth } from './PlatformAuthContext';

// Experience-layer guard for the platform subtree (plan §5.5). The real
// boundary is the backend (PlatformAuthGuard → 401/403); this only avoids
// flashing platform screens before redirecting to /platform/login.
export function PlatformProtectedRoute() {
  const { status } = usePlatformAuth();
  if (status === 'loading') return <div style={{ padding: 24 }}>加载中…</div>;
  if (status === 'anon') return <Navigate to="/platform/login" replace />;
  return <Outlet />;
}

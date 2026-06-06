import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Experience-layer guard only. The real security boundary is the backend:
// any API call without a valid token returns 401. This just avoids rendering
// authed screens before redirecting.
export function ProtectedRoute() {
  const { status } = useAuth();
  if (status === 'loading') return <div style={{ padding: 24 }}>加载中…</div>;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return <Outlet />;
}

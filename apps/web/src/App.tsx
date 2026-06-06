import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AppLayout } from './components/AppLayout';
import { SalesOrdersListPage } from './sales-orders/SalesOrdersListPage';
import { SalesOrderFormPage } from './sales-orders/SalesOrderFormPage';

// Placeholder home for the Foundation phase. Sales Orders pages arrive in the
// next phase (1B-SalesOrders-FE-CRUD).
function HomePage() {
  return <p>已登录。Sales Orders 页面将在下一阶段实现。</p>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/orders" element={<SalesOrdersListPage />} />
              <Route path="/orders/new" element={<SalesOrderFormPage />} />
              <Route path="/orders/:id/edit" element={<SalesOrderFormPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

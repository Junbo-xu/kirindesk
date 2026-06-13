import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AppLayout } from './components/AppLayout';
import { CustomersListPage } from './customers/CustomersListPage';
import { CustomerFormPage } from './customers/CustomerFormPage';
import { SuppliersListPage } from './suppliers/SuppliersListPage';
import { SupplierFormPage } from './suppliers/SupplierFormPage';
import { SalesOrdersListPage } from './sales-orders/SalesOrdersListPage';
import { SalesOrderFormPage } from './sales-orders/SalesOrderFormPage';
import { PurchaseOrdersListPage } from './purchase-orders/PurchaseOrdersListPage';
import { PurchaseOrderFormPage } from './purchase-orders/PurchaseOrderFormPage';
import { FilesListPage } from './files/FilesListPage';

// Placeholder home for the Foundation phase.
function HomePage() {
  return <p>已登录。请从顶部导航进入客户、供应商、销售订单或采购订单。</p>;
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
              <Route path="/customers" element={<CustomersListPage />} />
              <Route path="/customers/new" element={<CustomerFormPage />} />
              <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
              <Route path="/suppliers" element={<SuppliersListPage />} />
              <Route path="/suppliers/new" element={<SupplierFormPage />} />
              <Route path="/suppliers/:id/edit" element={<SupplierFormPage />} />
              <Route path="/orders" element={<SalesOrdersListPage />} />
              <Route path="/orders/new" element={<SalesOrderFormPage />} />
              <Route path="/orders/:id/edit" element={<SalesOrderFormPage />} />
              <Route path="/purchase-orders" element={<PurchaseOrdersListPage />} />
              <Route path="/purchase-orders/new" element={<PurchaseOrderFormPage />} />
              <Route path="/purchase-orders/:id/edit" element={<PurchaseOrderFormPage />} />
              <Route path="/files" element={<FilesListPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { SignupPage } from './auth/SignupPage';
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
import { ReportsPage } from './reports/ReportsPage';
import { CommissionSummaryPage } from './commission/CommissionSummaryPage';
import { CommissionOrdersPage } from './commission/CommissionOrdersPage';
import { CommissionTablesListPage } from './commission/CommissionTablesListPage';
import { CommissionTableFormPage } from './commission/CommissionTableFormPage';
import { CommissionSettlementsListPage } from './commission/CommissionSettlementsListPage';
import { CommissionSettlementDetailPage } from './commission/CommissionSettlementDetailPage';
import { CommissionPayoutsListPage } from './commission/CommissionPayoutsListPage';
import { CommissionPayoutDetailPage } from './commission/CommissionPayoutDetailPage';
import { OcrPage } from './ai/OcrPage';
import { CompletePage } from './ai/CompletePage';
import { UsersListPage } from './users/UsersListPage';
import { UserFormPage } from './users/UserFormPage';
import { RolesListPage } from './roles/RolesListPage';
import { RolePermissionsPage } from './roles/RolePermissionsPage';
import { SettingsPage } from './settings/SettingsPage';
import { AuditLogsPage } from './audit/AuditLogsPage';
import { SupportAccessPage } from './support-access/SupportAccessPage';
import { SubscriptionPage } from './subscription/SubscriptionPage';
import { NotificationSettingsPage } from './notification/NotificationSettingsPage';
import { BillingPage } from './billing/BillingPage';
import { PlatformAuthProvider } from './platform/PlatformAuthContext';
import { PlatformProtectedRoute } from './platform/PlatformProtectedRoute';
import { PlatformLayout } from './platform/PlatformLayout';
import { PlatformLoginPage } from './platform/PlatformLoginPage';
import { PlatformGrantsPage } from './platform/PlatformGrantsPage';
import { PlatformTenantsPage } from './platform/PlatformTenantsPage';
import { PlatformTenantViewPage } from './platform/PlatformTenantViewPage';

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
          <Route path="/signup" element={<SignupPage />} />
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
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/commission" element={<CommissionSummaryPage />} />
              <Route path="/commission/orders" element={<CommissionOrdersPage />} />
              <Route path="/commission/tables" element={<CommissionTablesListPage />} />
              <Route path="/commission/tables/new" element={<CommissionTableFormPage />} />
              <Route path="/commission/tables/:id" element={<CommissionTableFormPage />} />
              <Route path="/commission/settlements" element={<CommissionSettlementsListPage />} />
              <Route
                path="/commission/settlements/:id"
                element={<CommissionSettlementDetailPage />}
              />
              <Route path="/commission/payouts" element={<CommissionPayoutsListPage />} />
              <Route path="/commission/payouts/:id" element={<CommissionPayoutDetailPage />} />
              <Route path="/ai/ocr" element={<OcrPage />} />
              <Route path="/ai/complete" element={<CompletePage />} />
              <Route path="/users" element={<UsersListPage />} />
              <Route path="/users/new" element={<UserFormPage />} />
              <Route path="/users/:id/edit" element={<UserFormPage />} />
              <Route path="/roles" element={<RolesListPage />} />
              <Route path="/roles/new" element={<RolePermissionsPage />} />
              <Route path="/roles/:id/edit" element={<RolePermissionsPage />} />
              <Route path="/audit-logs" element={<AuditLogsPage />} />
              <Route path="/support-access" element={<SupportAccessPage />} />
              <Route path="/subscription" element={<SubscriptionPage />} />
              <Route path="/billing" element={<BillingPage />} />
              <Route path="/notification-settings" element={<NotificationSettingsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
          {/* Platform console: a fully separate auth subtree (plan §5.3/§5.5) —
              its own provider, login, protected route and layout, isolated from
              the tenant AuthProvider above (kd_platform_token vs kd_access_token). */}
          <Route
            path="/platform/*"
            element={
              <PlatformAuthProvider>
                <Routes>
                  <Route path="login" element={<PlatformLoginPage />} />
                  <Route element={<PlatformProtectedRoute />}>
                    <Route element={<PlatformLayout />}>
                      <Route path="tenants" element={<PlatformTenantsPage />} />
                      <Route path="support-grants" element={<PlatformGrantsPage />} />
                      <Route
                        path="support/tenants/:tenantId"
                        element={<PlatformTenantViewPage />}
                      />
                      <Route
                        path="*"
                        element={<Navigate to="/platform/support-grants" replace />}
                      />
                    </Route>
                  </Route>
                </Routes>
              </PlatformAuthProvider>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

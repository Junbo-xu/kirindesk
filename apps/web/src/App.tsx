import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { SignupPage } from './auth/SignupPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { PermissionRoute } from './auth/PermissionRoute';
import { ForbiddenPage } from './auth/ForbiddenPage';
import { AppLayout } from './components/AppLayout';
import { SensitivePageWatermark } from './components/SensitivePageWatermark';
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
import { WorkbenchPage } from './workbench/WorkbenchPage';
import { BusinessExceptionsPage } from './workbench/BusinessExceptionsPage';
import { BusinessTimelinePage } from './workbench/BusinessTimelinePage';
import { InquiriesListPage } from './workbench/InquiriesListPage';
import { QuoteTasksPage } from './workbench/QuoteTasksPage';
import { CommercialFlowPage } from './commercial/CommercialFlowPage';

function sensitive(element: React.ReactNode) {
  return <SensitivePageWatermark>{element}</SensitivePageWatermark>;
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
              <Route path="/forbidden" element={<ForbiddenPage />} />

              <Route element={<PermissionRoute permission="workbench:view" />}>
                <Route path="/" element={<WorkbenchPage />} />
              </Route>
              <Route element={<PermissionRoute permission="inquiries:view" />}>
                <Route path="/inquiries" element={<InquiriesListPage />} />
              </Route>
              <Route element={<PermissionRoute permission="quotations:view" />}>
                <Route path="/quote-tasks" element={sensitive(<QuoteTasksPage />)} />
              </Route>
              <Route
                element={
                  <PermissionRoute anyOf={['proforma_invoices:view', 'customer_receipts:view']} />
                }
              >
                <Route path="/commercial" element={sensitive(<CommercialFlowPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="business_exceptions:view" />}>
                <Route path="/exceptions" element={sensitive(<BusinessExceptionsPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="business_events:view" />}>
                <Route path="/timeline" element={sensitive(<BusinessTimelinePage />)} />
              </Route>
              <Route element={<PermissionRoute permission="customers:view" />}>
                <Route path="/customers" element={<CustomersListPage />} />
              </Route>
              <Route element={<PermissionRoute permission="customers:create" />}>
                <Route path="/customers/new" element={<CustomerFormPage />} />
              </Route>
              <Route element={<PermissionRoute permission="customers:update" />}>
                <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
              </Route>
              <Route element={<PermissionRoute permission="suppliers:view" />}>
                <Route path="/suppliers" element={sensitive(<SuppliersListPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="suppliers:create" />}>
                <Route path="/suppliers/new" element={sensitive(<SupplierFormPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="suppliers:update" />}>
                <Route path="/suppliers/:id/edit" element={sensitive(<SupplierFormPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="orders:view" />}>
                <Route path="/orders" element={<SalesOrdersListPage />} />
              </Route>
              <Route element={<PermissionRoute permission="orders:create" />}>
                <Route path="/orders/new" element={<SalesOrderFormPage />} />
              </Route>
              <Route element={<PermissionRoute permission="orders:update" />}>
                <Route path="/orders/:id/edit" element={<SalesOrderFormPage />} />
              </Route>
              <Route element={<PermissionRoute permission="procurement:view" />}>
                <Route path="/purchase-orders" element={sensitive(<PurchaseOrdersListPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="procurement:create" />}>
                <Route path="/purchase-orders/new" element={sensitive(<PurchaseOrderFormPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="procurement:update" />}>
                <Route
                  path="/purchase-orders/:id/edit"
                  element={sensitive(<PurchaseOrderFormPage />)}
                />
              </Route>
              <Route element={<PermissionRoute permission="files:view" />}>
                <Route path="/files" element={sensitive(<FilesListPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="reports:view" />}>
                <Route path="/reports" element={sensitive(<ReportsPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="commission_tables:view" />}>
                <Route path="/commission" element={sensitive(<CommissionSummaryPage />)} />
                <Route path="/commission/orders" element={sensitive(<CommissionOrdersPage />)} />
                <Route
                  path="/commission/tables"
                  element={sensitive(<CommissionTablesListPage />)}
                />
                <Route
                  path="/commission/settlements"
                  element={sensitive(<CommissionSettlementsListPage />)}
                />
                <Route
                  path="/commission/settlements/:id"
                  element={sensitive(<CommissionSettlementDetailPage />)}
                />
                <Route
                  path="/commission/payouts"
                  element={sensitive(<CommissionPayoutsListPage />)}
                />
                <Route
                  path="/commission/payouts/:id"
                  element={sensitive(<CommissionPayoutDetailPage />)}
                />
              </Route>
              <Route element={<PermissionRoute permission="commission_tables:lock" />}>
                <Route
                  path="/commission/tables/new"
                  element={sensitive(<CommissionTableFormPage />)}
                />
                <Route
                  path="/commission/tables/:id"
                  element={sensitive(<CommissionTableFormPage />)}
                />
              </Route>

              <Route element={<PermissionRoute anyOf={['ocr:view', 'ocr:process']} />}>
                <Route path="/ai/ocr" element={sensitive(<OcrPage />)} />
              </Route>
              <Route element={<PermissionRoute anyOf={['ai:view', 'ai:process']} />}>
                <Route path="/ai/complete" element={sensitive(<CompletePage />)} />
              </Route>
              <Route element={<PermissionRoute permission="users:view" />}>
                <Route path="/users" element={<UsersListPage />} />
              </Route>
              <Route element={<PermissionRoute permission="users:create" />}>
                <Route path="/users/new" element={<UserFormPage />} />
              </Route>
              <Route element={<PermissionRoute permission="users:update" />}>
                <Route path="/users/:id/edit" element={<UserFormPage />} />
              </Route>
              <Route element={<PermissionRoute permission="roles:view" />}>
                <Route path="/roles" element={<RolesListPage />} />
              </Route>
              <Route element={<PermissionRoute permission="roles:create" />}>
                <Route path="/roles/new" element={<RolePermissionsPage />} />
              </Route>
              <Route element={<PermissionRoute permission="roles:update" />}>
                <Route path="/roles/:id/edit" element={<RolePermissionsPage />} />
              </Route>
              <Route element={<PermissionRoute permission="audit_logs:view" />}>
                <Route path="/audit-logs" element={sensitive(<AuditLogsPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="support_access:view" />}>
                <Route path="/support-access" element={sensitive(<SupportAccessPage />)} />
              </Route>
              <Route element={<PermissionRoute anyOf={['tenant_settings:view', 'billing:view']} />}>
                <Route path="/subscription" element={<SubscriptionPage />} />
              </Route>
              <Route element={<PermissionRoute permission="billing:view" />}>
                <Route path="/billing" element={sensitive(<BillingPage />)} />
              </Route>
              <Route element={<PermissionRoute permission="tenant_settings:view" />}>
                <Route path="/notification-settings" element={<NotificationSettingsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
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

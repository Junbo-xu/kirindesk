export interface NavigationItem {
  label: string;
  to: string;
  anyOf: string[];
  workflow?: boolean;
}

export interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

export const NAVIGATION: NavigationGroup[] = [
  {
    label: '工作',
    items: [
      { label: '角色工作台', to: '/', anyOf: ['workbench:view'], workflow: true },
      { label: '询盘', to: '/inquiries', anyOf: ['inquiries:view'], workflow: true },
      { label: '报价任务', to: '/quote-tasks', anyOf: ['quotations:view'], workflow: true },
      { label: '外贸单证', to: '/documents', anyOf: ['document_sets:view'], workflow: true },
      {
        label: 'PI 与收款',
        to: '/commercial',
        anyOf: ['proforma_invoices:view', 'customer_receipts:view'],
        workflow: true,
      },
      { label: '销售订单', to: '/orders', anyOf: ['orders:view'] },
      { label: '采购订单', to: '/purchase-orders', anyOf: ['procurement:view'] },
      { label: '履约与物流', to: '/fulfillment', anyOf: ['fulfillment:view'], workflow: true },
      {
        label: '报关资料',
        to: '/customs',
        anyOf: ['customs_declarations:view'],
        workflow: true,
      },
      { label: '样品单', to: '/samples', anyOf: ['sample_orders:view'], workflow: true },
      { label: '售后', to: '/after-sales', anyOf: ['after_sales:view'], workflow: true },
      {
        label: '业务异常',
        to: '/exceptions',
        anyOf: ['business_exceptions:view'],
        workflow: true,
      },
      {
        label: '凭证时间线',
        to: '/timeline',
        anyOf: ['business_events:view'],
        workflow: true,
      },
    ],
  },
  {
    label: '业务资料',
    items: [
      { label: '客户', to: '/customers', anyOf: ['customers:view'] },
      { label: '产品库', to: '/products', anyOf: ['products:view'] },
      { label: '供应商', to: '/suppliers', anyOf: ['suppliers:view'] },
      { label: '文件', to: '/files', anyOf: ['files:view'] },
    ],
  },
  {
    label: '财务',
    items: [
      {
        label: '财务核对',
        to: '/finance',
        anyOf: ['finance_reviews:view'],
        workflow: true,
      },
      { label: '经营报表', to: '/reports', anyOf: ['reports:view'] },
      { label: '提成', to: '/commission', anyOf: ['commission_tables:view'] },
      { label: '账单', to: '/billing', anyOf: ['billing:view'] },
    ],
  },
  {
    label: '管理',
    items: [
      { label: '用户', to: '/users', anyOf: ['users:view'] },
      { label: '角色', to: '/roles', anyOf: ['roles:view'] },
      { label: '审计', to: '/audit-logs', anyOf: ['audit_logs:view'] },
      { label: '支持访问', to: '/support-access', anyOf: ['support_access:view'] },
      { label: '套餐', to: '/subscription', anyOf: ['tenant_settings:view', 'billing:view'] },
      { label: '通知', to: '/notification-settings', anyOf: ['tenant_settings:view'] },
      { label: '设置', to: '/settings', anyOf: ['tenant_settings:view'] },
    ],
  },
];

export function visibleNavigation(
  permissions: Record<string, string>,
  workflowMode: 'active' | 'read_only' | 'hidden' = 'active',
): NavigationGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !(workflowMode === 'hidden' && item.workflow) &&
        item.anyOf.some((code) => Boolean(permissions[code])),
    ),
  })).filter((group) => group.items.length > 0);
}

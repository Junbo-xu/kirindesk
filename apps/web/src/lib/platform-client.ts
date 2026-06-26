import {
  ApiError,
  AuditChainVerifyResult,
  AuditLogDetail,
  AuditLogSummary,
  ListAuditLogsQuery,
  ListPlatformTenantsQuery,
  ListUsersQuery,
  MyGrant,
  Paginated,
  PlatformAdmin,
  PlatformLoginResponse,
  PlatformTenantSummary,
  RoleSummary,
  UserSummary,
} from './types';

// Phase 1K-B platform console (plan §5.3/§5.4). The platform identity is a
// SECOND, fully separate auth: its JWT lives under its OWN storage key
// (kd_platform_token), never the tenant key (kd_access_token), and its 401
// handler runs a PLATFORM logout (clears the platform key + redirects to
// /platform/login) — so the two identities can never be confused (CLAUDE.md §4
// no-impersonation). This mirrors request<T>() in api-client.ts structurally
// but shares no token and no 401 hook with it.
const PLATFORM_TOKEN_KEY = 'kd_platform_token';

let onPlatformUnauthorized: (() => void) | null = null;
export function setPlatformUnauthorizedHandler(fn: (() => void) | null): void {
  onPlatformUnauthorized = fn;
}

export function getPlatformToken(): string | null {
  return localStorage.getItem(PLATFORM_TOKEN_KEY);
}
export function setPlatformToken(token: string): void {
  localStorage.setItem(PLATFORM_TOKEN_KEY, token);
}
export function clearPlatformToken(): void {
  localStorage.removeItem(PLATFORM_TOKEN_KEY);
}

interface PlatformRequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function platformRequest<T>(path: string, options: PlatformRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getPlatformToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth) {
    clearPlatformToken();
    if (onPlatformUnauthorized) onPlatformUnauthorized();
    throw new ApiError(401, '平台登录已过期，请重新登录');
  }

  if (!res.ok) throw await toApiError(res);

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Same NestJS error-body normalization as api-client.ts (kept local so the two
// clients stay fully independent — no shared module-level coupling).
async function toApiError(res: Response): Promise<ApiError> {
  let message = `请求失败 (${res.status})`;
  let fields: string[] | undefined;
  try {
    const data = await res.json();
    if (Array.isArray(data?.message)) {
      fields = data.message as string[];
      message = fields.join('；');
    } else if (typeof data?.message === 'string') {
      message = data.message;
    }
  } catch {
    // non-JSON body; keep the default message
  }
  return new ApiError(res.status, message, fields);
}

function auditQs(query: ListAuditLogsQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.actorId) params.set('actorId', query.actorId);
  if (query.actorType) params.set('actorType', query.actorType);
  if (query.action) params.set('action', query.action);
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.resourceId) params.set('resourceId', query.resourceId);
  if (query.requestId) params.set('requestId', query.requestId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const platformClient = {
  // No tenantSlug — platform login is email + password only.
  login(email: string, password: string): Promise<PlatformLoginResponse> {
    return platformRequest<PlatformLoginResponse>('/api/platform-auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });
  },
  getMe(): Promise<PlatformAdmin> {
    return platformRequest<PlatformAdmin>('/api/platform-auth/me');
  },
  logout(): Promise<{ message: string }> {
    return platformRequest<{ message: string }>('/api/platform-auth/logout', { method: 'POST' });
  },

  // "Which tenants named me?" — no per-tenant authorization, no audit (§3.6).
  listMyGrants(): Promise<MyGrant[]> {
    return platformRequest<MyGrant[]>('/api/platform/support/grants');
  },

  // Tenant lifecycle (1K-A, plan §3.4/§5.3). Metadata only — no business data.
  // The transition routes are POST /:id/{suspend,deactivate,activate}; suspend &
  // deactivate require a reason, activate's note is optional. 409 on an illegal
  // transition (e.g. suspend a non-active tenant), 404 on a missing tenant.
  listTenants(query: ListPlatformTenantsQuery = {}): Promise<Paginated<PlatformTenantSummary>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    return platformRequest<Paginated<PlatformTenantSummary>>(
      `/api/platform/tenants${qs ? `?${qs}` : ''}`,
    );
  },
  getTenant(id: string): Promise<PlatformTenantSummary> {
    return platformRequest<PlatformTenantSummary>(`/api/platform/tenants/${id}`);
  },
  suspendTenant(id: string, reason: string): Promise<PlatformTenantSummary> {
    return platformRequest<PlatformTenantSummary>(`/api/platform/tenants/${id}/suspend`, {
      method: 'POST',
      body: { reason },
    });
  },
  deactivateTenant(id: string, reason: string): Promise<PlatformTenantSummary> {
    return platformRequest<PlatformTenantSummary>(`/api/platform/tenants/${id}/deactivate`, {
      method: 'POST',
      body: { reason },
    });
  },
  activateTenant(id: string, reason?: string): Promise<PlatformTenantSummary> {
    return platformRequest<PlatformTenantSummary>(`/api/platform/tenants/${id}/activate`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },

  // Authorized read-only views over a specific tenant. Each requires an active
  // grant naming this admin for that tenant (SupportAccessGuard → 403 else) and
  // is audited into the tenant chain before the read (plan §3.4).
  tenantAuditLogs(
    tenantId: string,
    query: ListAuditLogsQuery = {},
  ): Promise<Paginated<AuditLogSummary>> {
    return platformRequest<Paginated<AuditLogSummary>>(
      `/api/platform/support/tenants/${tenantId}/audit-logs${auditQs(query)}`,
    );
  },
  tenantAuditLog(tenantId: string, id: string): Promise<AuditLogDetail> {
    return platformRequest<AuditLogDetail>(
      `/api/platform/support/tenants/${tenantId}/audit-logs/${id}`,
    );
  },
  tenantAuditChain(tenantId: string): Promise<AuditChainVerifyResult> {
    return platformRequest<AuditChainVerifyResult>(
      `/api/platform/support/tenants/${tenantId}/audit-logs/chain/verify`,
    );
  },
  tenantUsers(tenantId: string, query: ListUsersQuery = {}): Promise<Paginated<UserSummary>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    return platformRequest<Paginated<UserSummary>>(
      `/api/platform/support/tenants/${tenantId}/users${qs ? `?${qs}` : ''}`,
    );
  },
  tenantRoles(tenantId: string): Promise<RoleSummary[]> {
    return platformRequest<RoleSummary[]>(`/api/platform/support/tenants/${tenantId}/roles`);
  },
};

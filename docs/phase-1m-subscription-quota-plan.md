# Phase 1M 规划 — 订阅套餐与配额管理

## 1. 目标与范围

让 KirinDesk 具备完整的 SaaS 套餐层：
- 租户绑定套餐（plan_id），套餐决定可用模块 + 配额上限
- 配额门控：用户数、存储用量、AI 调用次数超限时 API 返回 429
- 平台管理员可查看 / 变更任意租户的套餐
- 租户 owner 可查看自己的套餐详情与配额用量
- 为 Phase 2C（移动端）预留 REST 接口，不做原生实现

不在本阶段做：在线支付、自动续费、账单（Phase 2A）。

---

## 2. 现有 DB 结构复用

| 表 | 已有内容 |
|---|---|
| `modules` | 8 个模块 seed，code/name/sort_order |
| `plans` | 3 个套餐 seed（free/standard/professional），max_users/max_storage_gb/ai_quota_monthly |
| `plan_modules` | 套餐 → 模块映射 |
| `tenant_modules` | 租户 → 模块 enabled/disabled |
| `tenants` | 无 plan_id，无配额快照 |

---

## 3. 数据库变更（migration 035）

### 3.1 `tenants` 加 `plan_id`

```sql
ALTER TABLE tenants
  ADD COLUMN plan_id uuid REFERENCES plans(id),
  ADD COLUMN plan_assigned_at timestamptz,
  ADD COLUMN plan_expires_at timestamptz;   -- NULL = 永久有效
```

`plan_id` 允许 NULL（平台在开通时赋值；历史租户默认 standard）。

### 3.2 配额用量快照表 `tenant_quota_usage`

实时聚合贵，写一张日常快照：

```sql
CREATE TABLE tenant_quota_usage (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  user_count integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,   -- 文件总大小
  ai_calls_month integer NOT NULL DEFAULT 0, -- 当月 AI 调用次数
  ai_calls_reset_at timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

写时机：
- 用户增删 → 触发器或 API 层递增/递减 `user_count`
- 文件上传/删除 → API 层递增/递减 `storage_bytes`
- AI 调用 → API 层递增 `ai_calls_month`；月份变化时 reset

> **选择快照而非实时聚合**：避免 COUNT(*) 跨大表全扫，与 1F-D 报表的设计决策一致。

### 3.3 RLS

`tenant_quota_usage` 行级隔离：`tenant_id = current_setting('app.tenant_id')::uuid`，只读（UPDATE 只允许 `app_service` 角色）。

---

## 4. 后端（`apps/api`）

### 4.1 SubscriptionModule（新模块）

```
apps/api/src/subscription/
  subscription.module.ts
  subscription.service.ts      # 套餐查询、变更、配额检查
  quota.service.ts             # 用量读写，门控逻辑
  subscription.controller.ts   # 租户侧 GET /api/subscription
  platform-subscription.controller.ts  # 平台侧 CRUD
  dto/
    assign-plan.dto.ts
    quota-usage.dto.ts
```

### 4.2 API 端点

**租户侧（kd_access_token）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/subscription` | 当前套餐 + 配额用量 + 模块列表 |

**平台侧（kd_platform_token）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/platform/plans` | 所有套餐列表 |
| GET | `/api/platform/tenants/:id/subscription` | 某租户套餐详情 |
| PUT | `/api/platform/tenants/:id/subscription` | 变更套餐（含 plan_expires_at） |

**预留移动端接口（Phase 2C 占位，本阶段实现）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mobile/v1/subscription` | 与 `/api/subscription` 相同响应结构，Bearer token 复用 |

> 本阶段只是路由别名，不做任何 native 特殊逻辑。2C 实际开发时直接扩展这个 controller。

### 4.3 配额门控 Guard

`QuotaGuard`：NestJS Guard，装饰器 `@CheckQuota('users' | 'storage' | 'ai')`。

- 拦截会触发配额消耗的端点
- 查 `tenant_quota_usage` + `plans.max_*`
- 超限返回 `429 Too Many Requests`，body `{ code: 'QUOTA_EXCEEDED', quota: 'users', limit: 10, current: 10 }`

装饰端点：
- `POST /api/users` → `@CheckQuota('users')`
- `POST /api/files` → `@CheckQuota('storage')`（检查 `storage_bytes + fileSize > max_storage_gb * 1GB`）
- `POST /api/ai/*` → `@CheckQuota('ai')`

### 4.4 模块门控（复用现有 tenant_modules）

Phase 1G 已有模块 seed，但未做运行时拦截。本阶段加 `ModuleGuard`：

`@RequireModule('procurement')` → 检查 `tenant_modules` 中 `enabled = true`，否则 `403 MODULE_NOT_ENABLED`。

装饰采购、财务、报表、AI 等模块的所有 controller（纯加法，不动已有逻辑）。

### 4.5 用量计数维护

在已有 Service 层加钩子（纯加法）：
- `UserService.create()` → `QuotaService.increment('users', tenantId)`
- `UserService.softDelete()` → `QuotaService.decrement('users', tenantId)`
- `FileService.upload()` → `QuotaService.addStorage(tenantId, bytes)`
- `FileService.softDelete()` → `QuotaService.subtractStorage(tenantId, bytes)`
- `AiService.invoke()` → `QuotaService.incrementAi(tenantId)` + 月份检查 reset

---

## 5. 前端（`apps/web`）

### 5.1 租户侧 — 套餐页

文件：`web/src/pages/SubscriptionPage.tsx`（挂到 `/subscription`，导航「套餐」）

展示：
- 当前套餐名称 + 到期时间
- 配额进度条：用户数 x/max、存储 xGB/maxGB、AI 本月 x/max
- 已启用模块列表

只读，无升级按钮（升级是 Phase 2A 的付费流程）。

### 5.2 平台侧 — 租户套餐管理

在已有 `PlatformTenantsPage` 的租户行详情里加「套餐」列 + 下拉变更入口（inline panel，与1L开通表单同风格）。

---

## 6. 集成测试

新增约 **15 个** `it` 用例：
1. 租户开通时自动创建 `tenant_quota_usage` 行
2. GET `/api/subscription` 返回正确套餐 + 用量
3. 用户数达上限 → POST `/api/users` 返回 429
4. 存储达上限 → POST `/api/files` 返回 429
5. AI 调用达上限 → 返回 429
6. 月份变化后 ai_calls_month reset
7. 平台变更套餐 → 再查用量上限变化
8. 未启用模块 → 访问对应 API 返回 403 MODULE_NOT_ENABLED
9. 移动端别名路由 GET `/api/mobile/v1/subscription` 与租户侧结果一致
10. RBAC：普通用户不能访问平台套餐 API

---

## 7. 文件清单

**新增**
- `db/migrations/035_subscription_quota.sql`
- `apps/api/src/subscription/` (5 files)
- `apps/web/src/pages/SubscriptionPage.tsx`

**修改（纯加法）**
- `apps/api/src/users/users.service.ts` — 加 QuotaService 钩子
- `apps/api/src/files/files.service.ts` — 加 QuotaService 钩子
- `apps/api/src/ai/ai.service.ts` — 加 QuotaService 钩子
- `apps/api/src/app.module.ts` — 注册 SubscriptionModule
- `apps/web/src/App.tsx` — 加 `/subscription` 路由
- `apps/web/src/components/AppLayout.tsx` — 加「套餐」导航项
- `apps/web/src/platform/PlatformTenantsPage.tsx` — 加套餐列 + 变更 panel

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| plan_id NULL 历史租户 | QuotaGuard 遇到 NULL plan_id 视为 standard，不阻塞 |
| 配额计数与实际不同步 | quota_usage 仅做软门控；超量 1-2 个可接受，不做强一致锁 |
| ModuleGuard 漏装饰 | 集成测试覆盖，未装饰的路由不影响功能只是没拦截 |

回滚：`migration 035` 有 DOWN 语句，删 `plan_id` + 删 `tenant_quota_usage` 表；Guard/钩子纯加法，回滚删文件即可。

---

## 9. 验收标准

- `pnpm verify` 全绿（现有 304 + 约 15 新用例）
- GET `/api/subscription` 正确返回套餐与用量
- 用户数超限 → 429，storage 超限 → 429
- 未启用模块 → 403
- 移动端预留路由可访问
- 平台变更套餐后租户侧立即生效
- 浏览器 QA：套餐页配额进度条渲染正确

---

## 10. 执行顺序

§1 migration 035（plan_id + tenant_quota_usage）
§2 SubscriptionModule + QuotaService 后端核心
§3 QuotaGuard + ModuleGuard + 钩子接入
§4 集成测试
§5 前端套餐页 + 平台变更 panel
§6 移动端路由别名
§7 浏览器 QA + CLAUDE.md 更新

# Phase 1H 规划 — 租户 RBAC 角色 / 用户管理

复用既有 `users` / `roles` / `user_roles` / `role_permissions` 四张表(migration
009–012),不新建核心业务表。本文档逐节确认后再实施。

## 1. 目标与范围

### 1.1 背景与目标

KirinDesk 已有 11 个模块在后端强制 RBAC(`module:action` 权限码 +
`PermissionGuard` + dataScope),但**租户管理员目前没有任何产品内入口去管理本租户
的用户和角色** —— `users.service.ts` 只有认证用的 `findByEmailForAuth` /
`findById`,没有 `users.controller`,也没有角色管理端点或 UI。新建用户、建角色、
授权,目前只能直接改数据库。

本阶段目标:补上这块多租户自服务的关键缺口 —— 让持有相应权限的租户管理员能在
产品内:

- 管理本租户用户:列表、创建/邀请、改资料、停用/启用(软删/状态)、给用户分配
  角色。
- 管理本租户角色:列表、创建/编辑/删除自定义角色、为角色按权限码授予权限并设定
  数据范围(data_scope: all / own)。
- 在一个权限矩阵界面里查看「角色 × 权限」并勾选授权。

对应已 seed 但尚未落地的权限码:`users:view/create/update`、
`roles:view/create/update`(均属 system 模块 id …007)。

### 1.2 本阶段要做(范围内)

- **后端 users 端点**(`apps/api/src/users/users.controller.ts`,复用并扩展
  `users.service`):租户内用户的 list / getOne / create / update / 停用,以及
  「给用户设角色」(读写 `user_roles`)。全部 `@Controller('api/users')`,在
  `TenantAuthGuard + PermissionGuard` 下,按 `users:view/create/update` 守卫,
  RLS + dataScope 租户隔离。
- **后端 roles 端点**(新 `roles` 模块或并入 users 模块,实施时定):角色
  list / getOne / create / update / delete(仅非 system 角色可删),以及
  「替换角色权限集」(全量替换 `role_permissions`,每条带 data_scope)。按
  `roles:view/create/update` 守卫。
- **关键服务端护栏(本阶段安全重点,CLAUDE.md §3/§4)**:
  - 末位 owner 保护:不能停用 / 降权最后一个 `is_tenant_owner` 用户。
  - 禁止自我提权:调用者不能给自己或他人授予自己**不持有**的权限(防越权扩散)。
  - 禁止跨租户:所有用户 / 角色 / 授权操作都限本租户(RLS + 应用层双重)。
  - system 角色(`is_system=true`)不可编辑权限 / 不可删除。
  - 不能删除/停用自己当前登录账户(避免把自己锁死)。
- **审计**:用户增改、停用、角色增改删、权限授予 / 撤销、用户-角色绑定变更全部
  写 `audit_logs`(CLAUDE.md §6 「permission changes / user changes」必须可审计)。
- **Web 页面**(`apps/web/src/users/` + `apps/web/src/roles/`,沿用既有
  列表/表单 + api-client + 行内样式约定):用户列表/表单 + 角色分配,角色列表/
  编辑 + 权限矩阵勾选界面;无权限 403 优雅降级;导航入口。

### 1.3 本阶段不做(范围外)

- **不做平台侧(platform-admin)用户管理** —— 这是租户内自管理,平台管理员对租户
  业务数据的访问另有授权/审计要求(CLAUDE.md §3),不在此阶段混入。
- **不做密码自助重置 / 邮件邀请发信** —— 无真实邮件 provider(CLAUDE.md §7);
  创建用户先用「管理员设初始密码 / 占位邀请」的最小形态,发信留后续阶段。
- **不新增权限码、不新增模块**(只落地已 seed 的 users/roles 权限);不碰
  `audit_logs:view`、`*:export`(留给后续候选 B/C)。
- **不改 permissions / modules 表结构**,不改 `PermissionGuard` 的判定逻辑。
- **不做角色继承 / 多级角色 / ABAC**;data_scope 仍只支持现有的 all / own
  (`assigned` 若现存则照旧,不新增语义)。
- **不做用户批量导入 / 导出。**

### 1.4 复用既有约定

- 表:`users`(含 status / is_tenant_owner / deleted_at 软删 / UNIQUE
  tenant_id+email)、`roles`(is_system / UNIQUE tenant_id+name)、`user_roles`
  (UNIQUE tenant_id+user_id+role_id)、`role_permissions`(data_scope,UNIQUE
  tenant_id+role_id+permission_id)—— 均已存在且带 tenant_id,无需 migration。
- 后端:NestJS 模块/控制器/服务 + DI、`withTenantContext` 设租户上下文、
  `@RequirePermission` + `PermissionGuard` 注入 dataScope、`AuditService.log`
  审计双写,全部照既有模块同构。
- 前端:`request<T>()` + `apiClient` 单例、`ApiError` 按 status 映射文案、
  行内 `CSSProperties` + 中文、403 优雅降级,照 commission/reports/files 页同构。
- 验证:`pnpm verify` 全绿(lint/format/typecheck/build/unit/integration/
  security 13)为提交前置。

## 2. 数据模型与复用

本阶段**零 migration**:所需四张表 + 权限/模块字典表均已存在,且都已带
tenant_id、FORCE RLS 租户隔离策略(migration 021)、索引、约束。下面逐表说明
形状与本阶段如何使用。

### 2.1 既有表(均已有 FORCE RLS,policy = `tenant_id = app_current_tenant_id()`)

**`users`**(009 + 021):
`id, tenant_id→tenants, email, password_hash, name, phone, status('active'…),
is_tenant_owner bool, last_login_at, created_at, updated_at, deleted_at`;
`UNIQUE (tenant_id, email)`;索引 tenant_id / status / deleted_at。
- 本阶段:list / getOne / create / update / 停用启用(改 `status` 或置
  `deleted_at` 软删,实施时定二选一并统一)。`password_hash` 绝不进任何响应
  DTO。创建用户由管理员设初始密码(bcrypt 同既有认证)。`is_tenant_owner` 受
  末位 owner 护栏保护(§4)。

**`roles`**(010 + 021):
`id, tenant_id→tenants, name, description, is_system bool, created_at,
updated_at`;`UNIQUE (tenant_id, name)`;索引 tenant_id。
- 本阶段:list / getOne / create / update / delete。`is_system=true` 角色只读
  (不可改权限、不可删、不可改名),由服务端拒绝(§4)。

**`user_roles`**(011 + 021):
`id, tenant_id, user_id→users, role_id→roles, created_at`;
`UNIQUE (tenant_id, user_id, role_id)`;索引 user_id / role_id。
- 本阶段:读某用户的角色集;「设角色」= 在一个 tx 内全量替换该用户的
  user_roles 行(删旧增新),受护栏约束。UNIQUE 防重复绑定。

**`role_permissions`**(012 + 021):
`id, tenant_id, role_id→roles, permission_id→permissions, data_scope
varchar(20) DEFAULT 'all', created_at`;
`UNIQUE (tenant_id, role_id, permission_id)`;索引 role_id / permission_id。
- 本阶段:读某角色的权限集(permission_id + data_scope);「替换角色权限」=
  在一个 tx 内全量替换该角色的 role_permissions 行,每条带 data_scope。
  data_scope 取值沿用现状(all / own;若代码已用 assigned 则照旧,不新增)。

### 2.2 既有字典表(全局,无 tenant_id,只读)

**`permissions`**(`id, module_id→modules, code, name, action, description`,
`code` 全局 UNIQUE)与 **`modules`**(`id, code, name, sort_order`)。
- 本阶段:权限矩阵的数据源 —— 按 module 分组列出所有 permission 供角色编辑器
  勾选。只读,不增删改;新权限码仍由 seed 维护(本阶段不加码)。

### 2.3 写操作的事务与上下文

- 所有写都经 `withTenantContext`(设 `app.current_tenant_id` /
  `current_user_id`),让 FORCE RLS 与审计链生效;`app_current_tenant_id()`
  即 RLS policy 依据,跨租户行天然不可见 / 不可写(WITH CHECK)。
- 「替换用户角色集」「替换角色权限集」是**全量替换语义**,必须在单个事务内
  (`DELETE …` + 批量 `INSERT …`)完成,失败整体回滚;审计在提交后写。
- `app` 角色对这四张表的 DML 权限沿用 migration 000 默认授予(无 append-only
  REVOKE),本阶段不改授权。

### 2.4 不需要的变更

- 无新表、无新列、无新索引、无新约束、无新 RLS policy → **无 migration**。
- 无新权限码、无 modules/permissions 字典改动。
- 不改 `PermissionGuard`、不改 `withTenantContext`、不改审计链结构。

## 3. 后端 API 端点(待补充)

## 4. 安全护栏与审计(待补充)

## 5. 前端页面与导航(待补充)

## 6. 风险与回滚(待补充)

## 7. 验证命令与验收标准(待补充)

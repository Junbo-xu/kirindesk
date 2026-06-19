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

## 3. 后端 API 端点

两个控制器,均 `@UseGuards(TenantAuthGuard, PermissionGuard)`,DTO 走全局
ValidationPipe(whitelist + forbidNonWhitelisted + transform),响应经 mapper
塑形(绝不返回 `password_hash` 等内部列),与既有 suppliers/customers 模块同构。
所有写经 `withTenantContext` + 单事务 + 提交后审计(§4)。

### 3.1 用户管理 `@Controller('api/users')`

| 方法 & 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/users` | `users:view` | 列表(分页 page/pageSize,可选 q 按 name/email 模糊,可选 status 过滤);dataScope 推入 WHERE;不含已软删(除非显式 includeDeleted,实施时定)。 |
| `GET /api/users/:id` | `users:view` | 单个用户 + 其角色集(`user_roles` join `roles`);越权/跨租户 → 不透明 404。 |
| `POST /api/users` | `users:create` | 创建用户:email(租户内唯一,409 重复)、name、初始 password(bcrypt 哈希)、可选 phone、可选 roleIds[]。`is_tenant_owner` **不**经此端点设置(防提权);默认 false。 |
| `PATCH /api/users/:id` | `users:update` | 改 name/phone/status(启用停用);不改 email、不改 password(密码重置留后续);停用受护栏约束(§4)。 |
| `PUT /api/users/:id/roles` | `users:update` | 全量替换该用户的角色集(单事务:删旧 user_roles + 插新);受「不可授予自己不持有的权限」「末位 owner」护栏。 |
| `DELETE /api/users/:id` | `users:update` | 软删(置 deleted_at)/ 停用;不可删自己、不可删末位 owner(§4)。无硬删。 |

> 说明:用户没有独立的 `users:delete` seed 码,停用/软删归入 `users:update`
> 语义(本阶段不新增权限码)。create 用 `users:create`,其余读 `users:view`。

### 3.2 角色管理 `@Controller('api/roles')`

| 方法 & 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/roles` | `roles:view` | 列表(本租户全部角色,含 is_system 标记 + 每角色权限计数)。 |
| `GET /api/roles/:id` | `roles:view` | 单个角色 + 其权限集(`role_permissions` 的 permission_id + data_scope)。 |
| `POST /api/roles` | `roles:create` | 创建自定义角色:name(租户内唯一,409 重复)、可选 description;`is_system` 恒 false(不可经 API 造系统角色)。 |
| `PATCH /api/roles/:id` | `roles:update` | 改 name/description;`is_system=true` 角色 → 403/409 拒绝(§4)。 |
| `PUT /api/roles/:id/permissions` | `roles:update` | 全量替换角色权限集(单事务:删旧 role_permissions + 插新,每条 {permissionId, dataScope});受「不可授予自己不持有的权限」+「data_scope 不得超出自己的范围」护栏;system 角色拒绝。 |
| `DELETE /api/roles/:id` | `roles:update` | 删除自定义角色;`is_system` 角色拒绝;若仍被 user_roles 引用 → 409(或先校验无绑定)。 |

> 角色无独立 `roles:delete` seed 码,删除归入 `roles:update`。

### 3.3 辅助读端点(供权限矩阵)

| 方法 & 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/permissions` | `roles:view` | 全部权限码按 module 分组(只读字典:module code/name + 其下 permission code/name/action),供角色编辑器渲染矩阵。无租户维度(全局表),但仍需登录 + `roles:view`。 |

### 3.4 服务层(扩展既有 `users.service` + 新 `roles.service`)

- `users.service` 增:`list / getOne(含角色) / create / update / setRoles /
  deactivate`,沿用 `@Inject(APP_POOL)` + `withTenantContext`。
- 新 `roles.service`:`list / getOne(含权限) / create / update / delete /
  setPermissions`,以及 `listPermissionCatalog`(供 §3.3)。
- 护栏判定(末位 owner、自我提权、system 角色只读、调用者权限子集校验)集中在
  service 层,**不依赖前端隐藏**(CLAUDE.md §4),详见 §4。

### 3.5 dataScope 与隔离

- 读端点把 `req.dataScope`(PermissionGuard 注入)推入 WHERE:scope=own 的管理员
  只能看到与自己相关的用户(实施时定 own 在 users 上的语义 —— 一般 user 管理
  属管理职能,建议 own 退化为「只看自己」或直接要求 all;在 §4 明确)。
- 跨租户由 FORCE RLS 兜底:任何 id 命中别租户行都返回不透明 404,不泄漏存在性。

### 3.6 不做的端点

- 无密码重置 / 改密端点(留后续 + 需邮件 provider)。
- 无 `is_tenant_owner` 转移端点(owner 移交是敏感流程,单独阶段设计)。
- 无平台侧用户管理(platform-auth 域不在此阶段)。
- 无批量导入 / 导出。

## 4. 安全护栏与审计

RBAC 管理是提权的天然入口,护栏全部在**服务端**强制(CLAUDE.md §4:UI 隐藏不是
安全边界)。下列每条都是服务层判定,违例返回明确错误码并**不**落数据(事务回滚)。

### 4.1 护栏(服务端强制)

1. **不可越权扩散(subset guard,核心)**:调用者授予角色/用户的权限,不得超出
   调用者**自己持有**的权限集 —— 既不能授予自己没有的权限码,也不能把某权限的
   data_scope 设得比自己在该码上的范围更宽(own 的人不能授出 all)。
   - 判定:对 `PUT /roles/:id/permissions`(及经 user_roles 间接生效的授权),
     逐条用 `RbacService.checkPermission(callerId, tenantId, code)` 取
     `{allowed, dataScope}`;要求 `allowed=true` 且 `requestedScope ⊆ callerScope`
     (scope 偏序:all ⊇ own)。任一条不满足 → **403**,整体拒绝。
   - 可加一个 `RbacService.listEffectivePermissions(userId, tenantId)` 辅助方法
     一次取全集做批量校验(避免 N 次查询);若不加则循环 checkPermission。
2. **末位 owner 保护**:不能停用 / 软删 / 移除最后一个 `is_tenant_owner=true`
   且 status=active 的用户。改动前在事务内 `COUNT(*)` 校验,若该操作会使活跃
   owner 数归零 → **409**。
3. **不可自锁**:调用者不能停用 / 软删自己当前登录账户(`:id === caller.sub`
   → **409/400**),避免把自己锁死在外。
4. **system 角色只读**:`is_system=true` 的角色不可改名/改描述、不可改权限、
   不可删除 → **403**(或 409)。仅自定义角色可编辑。
5. **删除/解绑前置校验**:删自定义角色时,若仍被 `user_roles` 引用 → **409**
   (要求先解绑),避免悬空授权。
6. **唯一性**:用户 email、角色 name 在租户内唯一(DB UNIQUE 兜底)→ 重复 **409**。
7. **租户隔离**:所有操作经 `withTenantContext` + FORCE RLS;跨租户 id → 不透明
   **404**,不泄漏存在性(§3.5)。
8. **dataScope on users 读**:user/role 管理属管理职能,建议读端点要求 scope=all
   才返回全租户;scope=own 退化为「仅自己」(在 §3.5 已述,§4 钉死语义)。
9. **owner 标志不可经普通端点设置**:`is_tenant_owner` 不接受来自 create/update
   DTO 的赋值(whitelist DTO 不含该字段),杜绝自助升为 owner。

### 4.2 审计(CLAUDE.md §6:user changes / permission changes 必须可审计)

全部经 `AuditService.log({ tenantId, actorType:'tenant_user', actorId, action,
resourceType, resourceId, before, after, metadata, ip, userAgent })`,在事务
**提交后**写,失败不影响主操作返回(沿用既有 best-effort 模式),写入
append-only 哈希链(`audit_logs`,REVOKE UPDATE/DELETE)。

| 操作 | action | resourceType | before/after / metadata |
|---|---|---|---|
| 创建用户 | `user.created` | `user` | after: 用户摘要(无 password) |
| 改用户资料/状态 | `user.updated` | `user` | before/after: 变更字段(name/phone/status) |
| 停用/软删用户 | `user.deactivated` | `user` | before/after: status / deleted_at |
| 替换用户角色 | `user.roles_replaced` | `user` | before/after: roleId 集合 |
| 创建角色 | `role.created` | `role` | after: name/description |
| 改角色 | `role.updated` | `role` | before/after: 变更字段 |
| 删角色 | `role.deleted` | `role` | before: 角色摘要 |
| 替换角色权限 | `role.permissions_replaced` | `role` | before/after: {permissionId, dataScope} 集合 |

- **敏感性**:审计只记 permissionId / roleId / 状态等**标识与摘要**,不记
  password、不记任何业务数据;before/after 是授权集合的差异,正是 §6 要求的
  「permission changes」可追溯证据。
- 既有 `PermissionGuard` 已对**被拒绝**的权限访问写 `rbac:permission_denied`
  审计 —— 本阶段的 403 护栏命中时同样会留痕(经 guard 或显式补记,实施时统一)。

### 4.3 验证这些护栏

集成测试覆盖(§7 详列):subset guard(own 用户授 all 被拒 / 授自己没有的码被拒)、
末位 owner 停用被拒、自锁被拒、system 角色改权限被拒、跨租户 404、重复 email/name
409、以及每条写操作的审计双写 + 审计链 `verifyChain` PASS。

## 5. 前端页面与导航(待补充)

## 6. 风险与回滚(待补充)

## 7. 验证命令与验收标准(待补充)

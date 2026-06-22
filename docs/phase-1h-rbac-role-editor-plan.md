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

## 5. 前端页面与导航

沿用既有 `apps/web/src/<module>/` + `App.tsx` 路由 + `AppLayout` 扁平导航 +
`request<T>()`/`apiClient` + `ApiError` 按 status 映射 + 行内 `CSSProperties`
中文 + 403 优雅降级的约定(同 commission/files/reports 页)。纯前端,无新依赖。

### 5.1 页面

**用户管理**(`apps/web/src/users/`):

- `UsersListPage.tsx`(路由 `/users`):用户列表(name / email / status /
  角色名 / 创建时间),分页 + q 搜索 + status 过滤;行操作:编辑、停用/启用;
  顶部「新建用户」。无 `users:view` → 403 优雅降级(整页提示「没有权限」)。
- `UserFormPage.tsx`(路由 `/users/new` 与 `/users/:id/edit`):创建填
  email + name + 初始密码(+ 可选 phone),编辑改 name/phone/status(email、
  密码不可改);底部「角色分配」多选(复选框列出本租户角色),提交时调
  `PUT /api/users/:id/roles` 全量替换。错误映射:409 重复 email、403 无权限/
  护栏命中(末位 owner、自锁、越权授权)、404。

**角色管理**(`apps/web/src/roles/`):

- `RolesListPage.tsx`(路由 `/roles`):角色列表(name / description /
  is_system 标记 / 权限数 / 引用用户数);system 角色行禁用编辑/删除按钮(仅 UI
  提示,服务端才是真相源);顶部「新建角色」。无 `roles:view` → 403 降级。
- `RoleFormPage.tsx`(路由 `/roles/new` 与 `/roles/:id/edit`):name +
  description;核心是**权限矩阵**:调 `GET /api/permissions` 取按 module 分组的
  权限字典,渲染「模块分组 × 权限码」复选 + 每条选中项的 data_scope 下拉
  (all / own);提交时 `PUT /api/roles/:id/permissions` 全量替换。is_system
  角色进入只读视图(不可勾选、不可保存)。错误映射:409 重复 name / 仍被引用、
  403 system 只读 / 越权授权(授了自己没有的码或超范围)、404。

### 5.2 api-client / 类型扩展

`lib/api-client.ts` 新增方法(走既有 `request<T>()`,查询串用 `URLSearchParams`
helper 同 `listFiles`):
`listUsers / getUser / createUser / updateUser / setUserRoles / deactivateUser`、
`listRoles / getRole / createRole / updateRole / deleteRole / setRolePermissions`、
`listPermissionCatalog`。
`lib/types.ts` 新增:`UserSummary / UserDetail(含 roles[])`、`RoleSummary /
RoleDetail(含 permissions[]: {permissionId, dataScope})`、`PermissionCatalog`
(module 分组)、各请求体类型。字段严格对齐后端 mapper 输出(**绝不含**
password_hash)。

### 5.3 导航

`AppLayout.tsx` 在「设置」附近(系统管理一类)新增两个链接:

```tsx
<Link to="/users">用户</Link>
<Link to="/roles">角色</Link>
```

照既有约定:链接始终可见,访问控制在后端;无权限用户进页面后首个 list 请求
返回 403,页面渲染「没有权限」提示而非崩溃(`/api/auth/me` 不带权限码,UI 不做
权限隐藏 —— 与 Phase 1G 同一处理)。

### 5.4 不做

- 不做权限码的中文 label 本地化字典之外的花哨分组 UI;矩阵用 module name +
  permission name(后端字典已带中文 name)朴素渲染即可。
- 不做拖拽 / 批量授权 / 角色克隆。
- 不做密码重置 UI、不做 owner 移交 UI(对应后端 §3.6 未做的端点)。
- 不做组件库引入,保持现有行内样式风格。

## 6. 风险与回滚

### 6.1 风险

本阶段是「RBAC 自管理」入口,本质是提权面,风险集中在授权正确性而非数据结构
(零 migration)。逐项缓解:

- **越权扩散(最高风险)**:管理员借角色编辑器授出自己没有的权限 / 更宽的
  data_scope,实现横向或纵向提权。缓解:§4.1 subset guard 服务端逐条强制
  (`allowed && requestedScope ⊆ callerScope`),集成测试专项覆盖;失败整体回滚
  不落库。
- **把租户锁死**:停用/降权最后一个 owner,或管理员自锁,导致无人能再管理租户。
  缓解:§4.1 末位 owner 护栏(活跃 owner 数不得归零)+ 不可自锁,事务内 COUNT
  校验,409 拒绝。
- **system 角色被破坏**:误改/误删内置角色使既有用户集体失权。缓解:
  `is_system=true` 服务端只读(改权限/改名/删除全拒),前端按钮也禁用(双层)。
- **悬空授权**:删角色后 user_roles 仍引用。缓解:删除前置校验(仍被引用 →
  409,要求先解绑)。
- **响应泄漏敏感列**:user 响应误带 `password_hash`。缓解:mapper 显式白名单
  字段塑形(同既有模块),集成测试断言响应无 password_hash;DTO whitelist +
  forbidNonWhitelisted 也拒绝 `is_tenant_owner` 等入参提权。
- **跨租户**:任何 id 命中别租户行。缓解:FORCE RLS(migration 021 已在)+
  `withTenantContext`,不透明 404,集成测试跨租户用例兜底。
- **全量替换的并发竞态**:两个管理员同时替换同一角色权限集可能互相覆盖。缓解:
  替换在单事务内对目标 role / user 行 `SELECT … FOR UPDATE` 串行化(同既有
  commission 锁定写法);本阶段不引入乐观锁版本号。
- **审计链**:写授权却漏审计,破坏 §6 合规承诺。缓解:每个写操作提交后
  `AuditService.log`,集成测试断言审计双写 + `verifyChain` PASS。

### 6.2 回滚

- **零数据库变更**:无 migration、无 seed 改动(权限码已存在),所以回滚不涉及
  任何反向 migration 或数据迁移。
- 后端回滚 = `git revert` 对应 feat commit(新增 users/roles 控制器 + 服务 +
  DTO + module 注册),既有认证用的 `users.service` 既有方法签名不变(只新增方法),
  删除新增内容即恢复原状。
- 前端回滚 = `git revert` 对应 web commit(新增两组页面 + api-client/types/
  App.tsx/AppLayout 四处修改),纯增量,不改既有页面行为。
- 各步按既有纪律拆分 feat commit(后端、前端分开;docs 单独),可逐 commit
  独立回滚。

### 6.3 兼容性

- 不改 `PermissionGuard` / `withTenantContext` / 审计链结构 / 既有权限码 →
  既有 11 个模块的行为与现有 256 集成 + 13 安全测试不受影响,应保持全绿。
- 新端点是新增路由,不与既有路由冲突;新导航链接不改既有链接。
- 唯一的「行为变化」是:原本只能改库才能做的用户/角色管理,现在有了 API/UI —— 
  但所有变更都经 RBAC + 护栏 + 审计,不绕过任何既有安全控制。

## 7. 验证命令与验收标准

### 7.1 验证命令

实施每步后、提交前必须全绿:

```bash
# 全量质量门(lint → format:check → typecheck → build → unit → integration → security)
pnpm verify
```

快速本地子集:

```bash
pnpm --filter @kirindesk/api test:integration   # 后端集成(含本阶段新用例)
pnpm --filter @kirindesk/web typecheck && pnpm --filter @kirindesk/web build
pnpm test:security                              # 13 项安全回归
```

审计链单独核验(本阶段写授权,链必须保持完整):

```bash
pnpm --filter @kirindesk/database verify-chain "tenant:<dev-tenant-id>"
```

格式问题按 auto-memory 约定静默 `pnpm format` 修复后再跑,不单独汇报。

### 7.2 集成测试(后端,新增 users/roles 套件)

权限 / 认证门:

1. 无 token → 401;平台 token → 401(租户域端点);无 `users:view` 用户访问
   `GET /api/users` → 403;无 `roles:view` 访问 `GET /api/roles` → 403。

用户 CRUD:

2. `users:create` 用户创建成功;重复 email → 409;创建响应**不含**
   `password_hash`;DTO 拒绝 `is_tenant_owner` 越权入参(forbidNonWhitelisted)。
3. 更新 name/phone/status 成功;`GET /api/users/:id` 返回用户 + 角色集。

角色 CRUD + 权限矩阵:

4. 创建自定义角色成功;重复 name → 409;`is_system` 恒 false。
5. `PUT /api/roles/:id/permissions` 全量替换成功并可重读;`GET /api/permissions`
   返回按 module 分组的字典。

护栏(§4,逐条):

6. **subset guard**:scope=own 的管理员尝试授出 all → 403;授予自己**未持有**
   的权限码 → 403;整体不落库(重读权限集未变)。
7. **末位 owner**:停用/软删最后一个活跃 owner → 409。
8. **自锁**:停用/删除自己当前账户 → 409/400。
9. **system 角色只读**:改其权限 / 改名 / 删除 → 403。
10. **悬空授权**:删仍被 user_roles 引用的角色 → 409。
11. **跨租户**:tenant2 用户访问 tenant1 user/role :id → 不透明 404。

审计:

12. 每个写操作(user.created/updated/deactivated/roles_replaced、
    role.created/updated/deleted/permissions_replaced)各写一条 `audit_logs`,
    `before/after` 反映授权差异,响应/审计均无 password。
13. 全套操作后 `verifyChain(tenant:…)` → PASS。

### 7.3 浏览器 QA(手动,实施后执行)

前置:`docker compose up` + `pnpm db:migrate`,起 api + web,用持有
`users:*`/`roles:*` 的租户管理员登录(dev seed 的 admin@dev.local)。

1. 用户列表加载 / 分页 / 搜索 / status 过滤。
2. 新建用户(设初始密码)→ 出现在列表;用该账户能登录。
3. 编辑用户、分配角色 → 重新登录后该用户的权限随角色生效(挑一个受控页面验证
   可见/不可见)。
4. 角色列表;新建自定义角色;在权限矩阵勾选若干权限码 + 设 data_scope → 保存
   → 重读一致。
5. system 角色行的编辑/删除按钮禁用;强行调用(改 URL)仍被后端 403。
6. 护栏可见反馈:停用末位 owner → 看到 409 文案;授越权权限 → 403 文案。
7. 无权限用户(无 `users:view`/`roles:view`)进 `/users`、`/roles` → 「没有
   权限」优雅降级,不崩溃。

### 7.4 验收标准

- `pnpm verify` 全绿(既有 256 集成 + 13 安全**不回归**,新增 users/roles 用例
  全过)。
- §7.2 所有护栏用例按预期返回(尤其 subset guard、末位 owner、system 只读、
  跨租户 404)。
- §7.3 浏览器 QA 全部通过。
- `git diff --stat` 仅触及预期文件:后端 `apps/api/src/users/`、新
  `apps/api/src/roles/`、`app.module.ts` 注册;前端 `apps/web/src/users/`、
  `apps/web/src/roles/`、`lib/api-client.ts`、`lib/types.ts`、`App.tsx`、
  `AppLayout.tsx`;**无 migration、无 seed、无新依赖**。
- 响应体经断言确认无 `password_hash` 等敏感列。
- 代码 commit(后端 / 前端分开)与 docs commit 分离;显式 `git add` 列文件,
  不含 `.env`/`dist`/`node_modules`/日志。
- 完成后更新 CLAUDE.md 阶段汇总,标记 Phase 1H 完成。

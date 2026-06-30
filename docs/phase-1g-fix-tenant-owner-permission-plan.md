# Phase 1G-fix: 租户 Owner 超级管理员权限绕过（tenant-owner-grants-all）

## 背景 / 问题
验收时发现：以租户 owner 身份（`service@kirindesk.com`，users.is_tenant_owner = true）登录后，
几乎所有功能页面提示「无权限」，无法验收。

## 根因（已定位，2026-06-30）
权限校验是纯 RBAC 角色驱动的，**完全没有 owner 例外**：

- `apps/api/src/rbac/permission.guard.ts` L29：只调用 `rbacService.checkPermission(user.sub, tenantId, code)`，
  按 user_roles → role_permissions → permissions 查角色授权。
- `apps/api/src/rbac/rbac.service.ts` L40：用户没有任何角色授权时直接 `{ allowed: false }`。
- 新建租户 / 首个 owner 用户**默认没有分配任何角色**，于是 owner 寸步难行。
- `request.user`（来自 `tenant-jwt.strategy.ts` validate）只含 `sub/type/tenantId/email`，
  **不含 is_tenant_owner**；JWT payload（`auth.service.ts` L57）同样不含。

结论：这是设计缺陷——owner（租户所有者 / 超级管理员）应当天然拥有本租户所有权限，
不依赖是否被分配角色。当前实现缺这条规则。

## 修复方案（最小、单点、向后兼容）
让 `is_tenant_owner = true` 的用户在权限校验中自动放行全部权限、dataScope = 'all'。

### 1. JWT 带上 owner 标志
- `auth.service.ts` L57 payload 增加 `isTenantOwner: user.is_tenant_owner`
  （登录查询已 SELECT is_tenant_owner，确认 user 对象带该字段；不带则补 SELECT）。
- `tenant-jwt.strategy.ts` validate：返回对象增加 `isTenantOwner: payload.isTenantOwner === true`。
  （payload 旧 token 无此字段 → 归一化为 false，安全降级。）

### 2. PermissionGuard 加 owner 例外
`permission.guard.ts` canActivate，在 `if (!requirement) return true;` 之后、
RBAC 查询之前插入：
```ts
// 租户 owner（超级管理员）天然拥有本租户所有权限，不依赖角色分配。
if (user.isTenantOwner === true) {
  request.dataScope = 'all';
  return true;
}
```
仅对 `user.type === 'tenant_user'` 生效；平台管理员走另一套 guard，不受影响。

### 3.（可选，二选一）后端兜底：不要只信 token
token 里的 isTenantOwner 是登录时快照。若担心 owner 状态变更后旧 token 仍有效，
可在 guard 里对 owner 分支查一次 DB 确认 is_tenant_owner。
**取舍**：token 有效期仅 2h，快照可接受；优先用 token 方案（零额外 DB 查询），
本期不做 DB 兜底，记为低优先技术债。

### 4. listEffectivePermissions 的 owner 处理
`rbac.service.ts` listEffectivePermissions（用于「授权不得超过自己权限」的 subset 校验）：
owner 给别人分配角色时，其「自身权限集」应视为全集。
- 在调用方（users.service 改角色 / roles.service）若 actor 是 owner，跳过 subset 上限检查，
  或让 listEffectivePermissions 对 owner 返回全集。
- 二选一，实施时确认调用点。**这步关系到 owner 能否给业务员建角色/分权限**，不能漏。

## 影响面
- 不动数据库 schema（is_tenant_owner 列已存在）。
- 纯后端逻辑加法，对非 owner 用户零影响（现有 345 集成测试应保持绿）。
- 前端无需改（前端按 /me 或权限接口隐藏菜单的逻辑，需确认 owner 是否也拿到全量菜单——
  若前端也按权限列表渲染菜单，需让 owner 拿到全量，见下「前端确认点」）。

## 前端确认点
- 检查 `apps/web` 是否按「当前用户权限列表」决定显示哪些菜单/按钮。
- 若是，需要一个「当前用户有效权限」接口对 owner 返回全集，否则后端放行了但前端菜单仍隐藏。
- 验收标准要求 owner 能看到并进入**所有**菜单。

## 验证（验收用）
1. 单元/集成：新增用例——owner 用户无任何角色时，对各资源 `*:read/*:create` 均 allowed；
   非 owner 无角色仍 403。
2. `pnpm verify` 全绿（lint/format/typecheck/build/unit/integration/security）。
3. 浏览器 QA：用 service@kirindesk.com（owner）登录，逐个菜单进入，确认无「无权限」拦截：
   客户/供应商/销售订单/采购订单/文件/提成/报表/审计/支持访问/套餐/账单/通知/角色/用户/设置。
4. 反向验证：建一个普通业务员（无角色），确认仍受权限限制（不能误把所有人放行）。

## 提交
- feat commit（permission.guard + jwt strategy + auth.service + rbac.service/调用点 + 测试）
- docs commit（CLAUDE.md 标记本 fix + 更新操作手册「无权限」FAQ：owner 天然全权限）
- 推 origin main，回 commit hash。

## 验收标准
- owner（service@kirindesk.com）登录后所有业务菜单可进、可操作，无 403。
- 普通无角色用户仍被正确拦截。
- owner 可正常给业务员建角色、分权限。
- 全套质量门禁绿。

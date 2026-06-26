# Phase 1K-B 规划 — 受治理的平台支持访问(Platform Support Access)

本文件是 Phase 1K 的第二个子阶段。母规划
`docs/phase-1k-platform-access-tenant-lifecycle-plan.md` §1.4 把 1K 拆成两批:
**1K-A**(租户生命周期 + 全局状态闸门)已落地(见 CLAUDE.md §10:migration 036、
`api/platform/tenants` 生命周期端点、`TenantStatusMiddleware`);**1K-B** 就是母规划
里那条「平台支持访问 = 完全没有通道」的信任核心——把平台管理员对租户业务数据的访问,
从「无任何受治理通道」升级为「**须客户授权、带原因/范围/时限、全程审计、默认拒绝**」。

本文档先写 §1 目标与范围;经用户确认后再按节(§2 数据模型与迁移 …… §8 验收)
逐项钉死并实施。**不**在 §1 阶段写代码、建表或改 schema。

## 1. 目标与范围

### 1.1 背景与目标

CLAUDE.md §3 对外承诺把信任放在第一位:「客户数据属于客户」「平台管理员不得默认
无限访问租户业务数据」「未来的支持访问必须要求客户授权、原因、范围、时限和审计
日志」。1K-A 已补上租户生命周期一侧;支持访问这一侧**至今仍为零**:

- 平台管理员经 `/api/platform-auth` 以 `platform_admin` 身份(`tenantId: null`)
  登录,登录写入 `platform` 审计链;但**没有任何租户业务端点接受平台身份**(全仓
  `PlatformAuthGuard` 仅护 platform-auth 自身与 1K-A 的 `api/platform/tenants`
  生命周期端点,后者**只读元信息、不碰业务数据**),且 RLS 一律按
  `app_current_tenant_id()` 收口、对 `app` 角色无平台旁路。
- 也就是说:今天平台管理员**既无法**访问任何租户业务数据(与「无默认访问」一致,
  是好事),**也没有**一条「客户授权后、受控、受审计、限时」的支持访问路径——当
  客户真需要平台协助排障时,只能靠数据库直连等不可治理、不可审计的手段。§3 点名要做
  的那条「受治理支持访问」**根本不存在**。

本阶段目标:补上这条受治理通道,且让它**与已建好的审计查看/导出(1I/1J)形成闭环**:

1. **客户授权是基石**:支持访问由**有权的租户用户**授权,平台管理员**不能**自行
   授予自己访问租户业务数据的权限。授权携带**原因(reason) + 范围(scope) +
   时限(expires_at)**。
2. **默认拒绝、按授权放行**:平台管理员仅在**存在有效授权**(未撤销、未过期、范围
   匹配)时,才能在该范围/时限内访问对应租户数据;无有效授权 → **默认拒绝**。
3. **复用隔离而非开后门**:平台身份据有效授权获得一个**受限、限时**的租户上下文,
   走与租户用户**相同的** `withTenantContext` + RLS 读路径;平台身份**不绕过 RLS**,
   无授权时不设任何租户上下文。
4. **全程审计、对租户可见**:授权的创建/批准/到期/撤销,以及**每一次基于授权的
   访问**,经既有 `AuditService` 写审计,且**写入租户自己的链**(`tenant:<id>`),
   从而经 1I 审计查看器对客户呈现「谁、何时、凭哪条授权、为何访问了我的数据」。
   平台管理员的身份在审计中**始终保留为 `platform_admin`**,绝不伪装成租户用户。

> 1K-A 实测已确认一项关键前提:`AuditService` 以 session actor=`system` 写入,既有
> `audit_logs_system_insert` policy 允许把 `actor_type=platform_admin` 的行写入
> **租户链**(1K-A 的 `tenant.suspended/.activated/.deactivated` 即如此落链并通过
> chain verify)。因此母规划 §2.5 预想的「新增一条 `audit_logs` INSERT policy」
> **大概率无需**;§2 将据此复核,能省则省(不动既有审计 RLS 是上策)。

### 1.2 本阶段要做(范围内)

- **支持访问授权模型(新表)**:一条授权记录 = 「某租户的有权用户,授权某**具名**
  平台管理员,在某范围/时限内访问本租户数据」的客户授权凭证。字段至少含:`id`、
  `tenant_id`、被授权的 `platform_admin_id`(具名,非「任意平台管理员」)、
  `reason`、`scope`(范围语义 §3 钉死,如「只读」/限定模块集)、`expires_at`、
  状态(状态机覆盖 草拟/待批→生效→到期/撤销,精确状态集与转换 §3)、授权人
  (租户用户 id)、审计时间戳。表带 RLS(租户隔离)、append-only 倾向的写约束
  (授权一旦生效其核心字段冻结,撤销=追加状态变更而非改写——§3 钉死)。
- **租户侧授权管理端点**:有权的租户用户创建/批准/撤销对某平台管理员的支持访问授权;
  列出本租户的现存授权及其状态。受 `TenantAuthGuard` + `PermissionGuard` 把关。
- **平台侧据授权访问租户数据**:平台身份 + 有效授权 → 取得**受限、限时**的租户
  上下文,在**授权范围内**复用既有租户读路径取数;无/过期/越权授权 → 默认拒绝。
  「平台身份如何安全地取得这个受限租户上下文以复用既有读取」是本阶段核心设计点,
  在 §3/§4 钉死。本阶段平台侧**优先只读**(read-only scope);写访问是否开放、
  如何护栏,§3 评估(默认不开,降低风险)。
- **RBAC**:租户侧「授权支持访问」「撤销支持访问」是敏感操作,新增权限码(挂
  `system` 模块,§2/§3 定),默认仅租户 owner/管理员可授权;平台侧操作由平台身份 +
  平台侧校验把关。
- **审计闭环**:授权生命周期每次转换 + 每次基于授权的访问,经既有 `AuditService`
  入**租户链**(让客户经 1I 看见),action 类型新增(§2/§3 命名钉死);不动审计
  写路径/哈希/append-only。

### 1.3 本阶段不做(范围外)

- **不做平台侧「自由浏览租户业务数据」的控制台**:平台对租户数据的访问**只有**
  「客户授权 + 受限 + 限时 + 审计」这一条路径,**不**提供无授权的跨租户业务数据
  浏览/检索/分析界面。无默认访问是红线(§4)。
- **不做「冒名顶替」(impersonation)登录为某租户用户**:支持访问是平台管理员以
  **自己的平台身份**在授权范围内操作,审计中始终是 `platform_admin`,不伪装成租户
  用户、不签发租户用户 token。
- **不做客户授权的站外通知/邮件**(「平台请求访问,请批准」之类外发):通知属
  provider 抽象方向(母规划 §7 mock-first),本阶段授权在产品内完成,不外发。
- **不做后台自动到期清扫任务**:授权按 `expires_at` 在**使用时校验**即过期失效;
  独立的定时清扫/状态回填作为后续优化,本阶段不引(§风险与回滚记边界)。
- **不做平台侧写访问(默认)**:本阶段平台侧支持访问**优先只读**;若 §3 评估后开放
  受限写,也仅在授权 scope 明示且独立护栏下,默认关闭。
- **不改既有审计写入路径/哈希链/append-only 约束**:本阶段只**新增**被审计的 action
  类型(支持访问授权/访问),不动 `AuditService`、哈希算法、链结构、022/023 触发器。
- **不做租户生命周期相关**:启停/状态闸门已属 1K-A,本阶段不重复、不修改。

### 1.4 与既有设施 / 1K-A 的衔接

本阶段严格复用、绝不削弱既有边界:

- **平台身份(复用)**:沿用 `platform_admins` + `/api/platform-auth` 的
  `platform-jwt`(`type=platform_admin`、`tenantId: null`);在其之上加「据授权访问
  租户数据」端点,不改既有登录/审计。
- **租户隔离 / RLS(复用且不放大)**:支持访问取得的受限租户上下文走与租户用户
  **相同的** `withTenantContext` + RLS 路径——平台身份不绕 RLS,而是被授权后获得
  一个明确、限时的 `tenant_id` 上下文,因此天然只见被授权租户、且只在授权范围内;
  无授权不设上下文,默认拒绝。这是「复用隔离」而非「开后门」。
- **审计设施(复用,本阶段的收口)**:授权与访问都是 §6 明列的敏感操作,经既有
  `AuditService` 入**租户链**,经 1I 审计查看器对租户可见——「平台动了我的数据要
  留痕」在此闭环。审计写路径、哈希、append-only 一律不动(且 §1.1 已确认无需新增
  审计 RLS policy,待 §2 复核)。
- **与 1K-A 的边界**:1K-A 已落 migration 036(`tenants` 加 `suspended_at` /
  `suspended_reason` / `chk_tenants_status`)、`api/platform/tenants` 生命周期端点、
  `TenantStatusMiddleware` 全局状态闸门。本阶段**不碰**这些;**迁移号顺延为
  `037`**(036 已被 1K-A 占用),新表 + 其 RLS/约束/触发器 + 新 RBAC 码(走 seed)
  在 §2 定义。被支持访问命中的租户仍受 1K-A 状态闸门约束(对非 active 租户是否允许
  授权/访问,§3 钉死——倾向:停用租户不可新授权)。
- **净增**:相对 1K-A,本阶段净增一张 `support_access_grants` 表(+ 索引/RLS/写
  约束)、租户侧授权管理端点、平台侧据授权读取端点、若干新审计 action 与 RBAC 码。
  属跨身份边界的治理改动,§2(迁移)、§3/§4(平台取得受限租户上下文的机制、状态机、
  护栏)须逐项钉死后再实施。

### 1.5 核心不变式(贯穿全阶段,后续各节不得违背)

1. **客户授权是唯一入口**:无有效客户授权,平台绝不触达任何租户业务数据;平台不能
   自授。
2. **默认拒绝**:授权缺失/过期/撤销/范围外,一律拒绝(明确状态码,§4 定)。
3. **审计身份永远是平台身份**:基于授权的访问在审计中记 `platform_admin` + 授权 id,
   不伪装租户用户、不签租户 token。
4. **复用隔离,不绕 RLS**:受限租户上下文走既有 `withTenantContext`,平台身份无 RLS
   旁路。
5. **审计/约束设施不可削弱**:只新增 action 类型与一张表,绝不改哈希链、append-only、
   既有审计写路径。

## 2. 数据模型与迁移

本阶段**有一支迁移 `037`**(036 已被 1K-A 占用):新增一张支持访问授权表
`support_access_grants` + 其 RLS / 索引 / 冻结触发器,新增一个 SECURITY DEFINER
校验函数 `app_check_support_access(...)`(供平台侧读路径在设租户上下文前判定授权),
**不**新增 `audit_logs` policy(见 §2.6,母规划预想的那条经核查无需),哈希算法、链
结构、append-only(022/023)与 `AuditService` 一律不动。新增 RBAC 码走 seed(非
migration,见 §2.7)。

### 2.1 既有可复用(不改)

- **平台身份**:`platform_admins`(`id` uuid PK、`email`、`status` 等)+
  `/api/platform-auth`(`platform-jwt`,`type=platform_admin`、`tenantId: null`)。
- **租户隔离设施**:`app_current_tenant_id()` / `app_current_user_id()` /
  `app_current_actor_type()`(002)+ 各业务表 FORCE RLS + `withTenantContext`。支持
  访问取得的受限租户上下文走同一套,不绕 RLS。
- **审计**:`audit_logs` + `audit_log_chains` + `AuditService.writeToChain` + 1I
  查看器。授权/访问事件经其写入**租户链**、对租户可见;不新增审计表。
- **SECURITY DEFINER 先例**:028 的 `app_lookup_file_token`(匿名下载在无租户上下文
  时按哈希令牌解元数据)+ 029 的 `SET search_path = pg_catalog, public`(防 search_path
  劫持)。本阶段 `app_check_support_access` **完全照此模式**(SECURITY DEFINER +
  pinned search_path),是「无租户上下文时安全判定一条治理记录」的同类需求。
- **冻结触发器先例**:034 `commission_payouts` 的「BEFORE UPDATE 拒绝改金额列」与
  032/033 的 append-only 授予收口(REVOKE UPDATE/DELETE)。本表的字段冻结照此。

### 2.2 新表 `support_access_grants`(migration 037)

一条记录 = 「某租户的有权用户,授权某**具名**平台管理员,在某范围/时限内访问本租户
数据」的客户授权凭证。

| 列 | 类型 | 约束 / 说明 |
|---|---|---|
| `id` | `uuid` | PK,`DEFAULT uuid_generate_v4()` |
| `tenant_id` | `uuid` | NOT NULL,FK → `tenants(id)`;RLS 隔离键 |
| `platform_admin_id` | `uuid` | NOT NULL,FK → `platform_admins(id)` ON DELETE RESTRICT;**具名**被授权人,非「任意平台管理员」 |
| `scope` | `varchar(20)` | NOT NULL,`CHECK (scope IN ('read_only'))`;本阶段只放只读,列举式 CHECK 便于将来加值(§3 钉死语义) |
| `reason` | `text` | NOT NULL,授权原因(客户填),非空(应用层 DTO 也校验) |
| `status` | `varchar(20)` | NOT NULL `DEFAULT 'pending'`,`CHECK (status IN ('pending','active','revoked','expired'))`;状态机见 §3 |
| `expires_at` | `timestamptz` | NOT NULL,时限硬上界;到期判定在**使用时**比 `now()`(§3),不靠后台清扫 |
| `granted_by_user_id` | `uuid` | NOT NULL,FK → `users(id)` ON DELETE RESTRICT;发起/批准授权的租户用户(历史凭证,不可因删用户而丢) |
| `approved_at` | `timestamptz` | NULL;进入 `active` 的时刻(若采用 pending→active 两步,§3 定一步还是两步) |
| `revoked_by_user_id` | `uuid` | NULL,FK → `users(id)` ON DELETE SET NULL;撤销人 |
| `revoked_at` | `timestamptz` | NULL;撤销时刻 |
| `revoke_reason` | `text` | NULL;撤销原因(撤销时必填——应用层校验,呼应 1K-A suspend 的 reason 要求) |
| `created_at` | `timestamptz` | NOT NULL `DEFAULT now()` |
| `updated_at` | `timestamptz` | NOT NULL `DEFAULT now()` |

说明:
- **无 `soft delete`(`deleted_at`)**:授权是治理凭证,生命周期用 `status`
  (revoked/expired)表达,不软删——撤销=追加状态变更,保留完整轨迹(§3 不变式)。
- **被授权人具名**:`platform_admin_id` 指向一个具体平台管理员,避免「任一平台管理员
  凭一条授权都能进」;读路径据 `(platform_admin_id, tenant_id, 有效)` 命中(§2.4 函数)。
- **时限语义**:`expires_at` 是硬上界,有效性 = `status='active' AND now() < expires_at`;
  「过期」既可在使用时即时判定(必做),也可由后续清扫把 `active` 回填成 `expired`
  (本阶段不做清扫,§1.3)——故读路径**不能**只信 `status`,必须叠加 `now()` 比较。

### 2.3 RLS、索引、授予、冻结

**RLS(租户隔离)**:表 `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
(与全部业务表一致)。策略键 `app_current_tenant_id()`:

- `support_access_grants_tenant_select` / `_insert` / `_update`:
  `USING (tenant_id = app_current_tenant_id())`,`WITH CHECK` 同。租户用户经
  `withTenantContext` 只见/只写本租户授权。
- **平台读路径不靠 RLS 直查本表**:平台身份登录时 `tenantId: null`,不会设
  `app.current_tenant_id`,故对本表的 RLS SELECT 取不到行——这正是要 §2.4 的
  SECURITY DEFINER 函数(在无租户上下文下,安全地按 `(platform_admin_id, tenant_id)`
  判定有无有效授权)的原因,与 028 匿名下载取令牌同构。

**索引**:
- `idx_sag_tenant` ON `(tenant_id)`:RLS 过滤 + 租户侧列表。
- `idx_sag_admin_status` ON `(platform_admin_id, status)`:§2.4 函数按被授权人查有效授权。
- **`uq_sag_one_active` UNIQUE ON `(platform_admin_id, tenant_id)` WHERE
  `status = 'active'`**(partial unique):同一平台管理员对同一租户**至多一条**生效
  授权,避免重复授权语义混乱(照 034 `commission_payouts` 的 no-double-pay partial
  unique 先例)。

**授予(收口为「可读可写、不可硬删」)**:`GRANT SELECT, INSERT, UPDATE ON
support_access_grants TO kirindesk_app;` 且**不授 DELETE**(治理凭证不删,撤销走
UPDATE status——呼应授权表的 append-only 倾向)。

**冻结触发器 `trg_sag_freeze_immutable`(BEFORE UPDATE)**:核心字段一旦写入即不可
改——`tenant_id`、`platform_admin_id`、`scope`、`reason`、`expires_at`、
`granted_by_user_id` 在 UPDATE 时若与 OLD 不同则 `RAISE EXCEPTION`(照 034 冻结金额列
先例)。**仅允许**改 `status` / `approved_at` / `revoked_*` / `updated_at`,即生命
周期推进,不允许「偷改范围/时限/被授权人」。SECURITY DEFINER 不涉及(普通触发器)。

### 2.4 SECURITY DEFINER 校验函数 `app_check_support_access(...)`

平台读路径在**设置受限租户上下文之前**,需在无租户上下文下判定:这个平台管理员对
这个租户**此刻**有没有一条有效授权。照 028/029 模式:

```sql
CREATE OR REPLACE FUNCTION app_check_support_access(
  p_platform_admin_id uuid,
  p_tenant_id uuid
) RETURNS TABLE (grant_id uuid, scope text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public   -- 029 同款:防 search_path 劫持
AS $$
  SELECT id, scope
  FROM support_access_grants
  WHERE platform_admin_id = p_platform_admin_id
    AND tenant_id = p_tenant_id
    AND status = 'active'
    AND now() < expires_at            -- 时限在使用时即判,不靠清扫
  LIMIT 1;
$$;
```

- **SECURITY DEFINER + pinned search_path**:函数以属主权限读本表(绕过调用者无租户
  上下文导致的 RLS 空集),但**只回**「授权 id + scope」,不泄露其它租户授权;
  search_path 钉死,杜绝劫持(029 的教训)。
- **返回 grant_id**:供调用方把「凭哪条授权访问」写进审计(§4 不变式 3)。
- **`now() < expires_at` 内建**:即便后台没把过期授权回填成 `expired`,函数也不会
  把过期授权判为有效——读路径**只信此函数**,不直接信 `status`。
- **授予**:`GRANT EXECUTE ON FUNCTION app_check_support_access(uuid,uuid) TO
  kirindesk_app;`(与 028 函数授予一致)。
- **`REVOKE EXECUTE ... FROM PUBLIC`**:照 028/029,避免匿名/非应用角色调用。

### 2.5 迁移脚本结构(`037_support_access_grants.sql`)

`-- UP`(顺序):
1. `CREATE TABLE support_access_grants (...)`(§2.2 列 + CHECK + FK)。
2. `ENABLE` + `FORCE ROW LEVEL SECURITY`。
3. 三条租户 RLS policy(select/insert/update,§2.3)。
4. 三个索引(`idx_sag_tenant`、`idx_sag_admin_status`、partial unique `uq_sag_one_active`)。
5. `GRANT SELECT, INSERT, UPDATE ... TO kirindesk_app`(不授 DELETE)。
6. 冻结触发器函数 `sag_freeze_immutable()` + `CREATE TRIGGER trg_sag_freeze_immutable
   BEFORE UPDATE ...`。
7. `CREATE FUNCTION app_check_support_access(...)`(SECURITY DEFINER + pinned
   search_path)+ `REVOKE EXECUTE ... FROM PUBLIC` + `GRANT EXECUTE ... TO kirindesk_app`。

`-- DOWN`(逆序,可逆):
1. `DROP FUNCTION IF EXISTS app_check_support_access(uuid, uuid);`
2. `DROP TRIGGER IF EXISTS trg_sag_freeze_immutable ON support_access_grants;`
   `DROP FUNCTION IF EXISTS sag_freeze_immutable();`
3. `DROP TABLE IF EXISTS support_access_grants;`(连带 policy / 索引 / 授予)。

可逆性按本仓既有做法(1E 028/029、1F 系列)**实测 up→down→up**,不留残留对象。
DOWN 前若已有授权行,DROP TABLE 会连数据一并删——dev/test 可接受;生产侧本迁移是
**纯增表**,回滚等于「下线支持访问功能」,与现状(功能不存在)一致,无业务数据损失
(本表不含租户业务数据,只是治理凭证)。

### 2.6 为何**不**新增 `audit_logs` INSERT policy(对母规划 §2.5 的更正)

母规划 §2.5 预想要「新增一条 `audit_logs` INSERT policy 让平台访问事件落入租户链」。
**经 1K-A 实测核查,此条无需,且原拟法本身不成立**:

- 既有(migration-tracked)policy `audit_logs_system_insert`(021)的 `WITH CHECK` 是
  `app_current_actor_type() = 'system'`(对 `tenant_id` 不设限);而
  `AuditService.writeToChain` 在写前 `set_config('app.current_actor_type','system',
  true)`,故它能把 `actor_type='platform_admin'` 的行写入**任意租户链**。1K-A 的
  `tenant.suspended/.activated/.deactivated` 正是经此 policy 落入租户链并通过 chain
  verify。(注:`audit_logs_tenant_insert` 仅认 `tenant_user`,平台访问事件不走它;
  走的是 system 这条。)
- 母规划原拟的 policy 形如 `WITH CHECK (... app_check_support_access(
  app_current_user_id(), tenant_id) ...)` —— 但 `AuditService` 写审计时**从不设**
  `app.current_user_id`(它只设 `actor_type` 与 `tenant_id`),`app_current_user_id()`
  会是 NULL,该 CHECK 必然失败。即原拟法会**反而写不进**审计。
- **结论**:授权校验属**应用层**职责(平台读路径在取数前调
  `app_check_support_access` 判定,无效即拒并不取数),**不**塞进审计 RLS;审计只
  忠实记录「发生了一次平台访问」。本阶段因此**不动任何 `audit_logs` policy**,
  与「不削弱审计设施」的不变式一致。

> 旁注:平台访问事件落租户链所依赖的 `audit_logs_system_insert` 是
> **migration-tracked**(021),非漂移,本阶段照常复用、不改。

### 2.7 RBAC(走 seed,非 migration)

新增三个权限码,挂既有 `system` 模块(与 1H users/roles、1I audit_logs 同模块),经
seed 注入(非 migration),默认绑定到租户 owner/管理员角色:

- `support_access:grant` —— 创建/批准对某平台管理员的支持访问授权。
- `support_access:revoke` —— 撤销一条授权。
- `support_access:view` —— 查看本租户授权清单与状态。

平台侧「据授权访问租户数据」不引租户 RBAC 码(它由**平台身份 + 有效授权**双闸把关,
§3/§4 钉死);平台管理员之间是否再分级(谁能发起支持访问)在 §3 评估。授权码的具体
seed 文件位置、与 Dev Admin/owner 角色的绑定写法,在 §3 落地时按 1H 既有 seed 模式
(`FROM permissions p` 自动绑定 Dev Admin)给出。

### 2.8 迁移与数据模型小结

- 一支迁移 `037`:`support_access_grants` 表 + RLS(FORCE,租户隔离)+ 3 索引(含
  partial unique 单活授权)+ 冻结触发器(核心字段不可改)+ append-only 授予(无
  DELETE)+ `app_check_support_access` SECURITY DEFINER 校验函数(pinned search_path)。
- **不**新增/修改任何 `audit_logs` policy、哈希链、append-only(022/023)、
  `AuditService`(§2.6)。
- RBAC 三码走 seed(§2.7)。
- 表不含租户业务数据,仅治理凭证;回滚为纯下线,无业务数据损失(§2.5)。
- 具体状态机(pending 一步还是两步入 active)、scope 语义边界、平台读路径如何取得
  受限上下文、非 active 租户能否授权——留 §3/§4 钉死。

## 3. 后端 API 端点(端点 + 状态机 + 受限租户上下文)

本阶段后端分**两个端点面**:租户侧「授权管理」(`TenantAuthGuard + PermissionGuard`)、
平台侧「据授权只读访问」(`PlatformAuthGuard` + 新增 `SupportAccessGuard`)。**租户
生命周期(`api/platform/tenants` 启停)与全局状态闸门已在 1K-A 落地,本阶段不重复、
不修改**——只在 §3.5 引用它们与本阶段的关系。所有写与跨边界敏感读经既有
`AuditService` 留痕(命名/落链在 §4)。本节把状态机、受限租户上下文机制、scope 语义
钉死。

### 3.1 端点总览

**租户侧:支持访问授权**(`@Controller('api/support-access')`,`TenantAuthGuard +
PermissionGuard`):

| 方法 & 路由 | 权限 | 说明 |
|---|---|---|
| `POST /api/support-access` | `support_access:grant` | 创建一条 `active` 授权(`platformAdminEmail`→id、reason、scope、expiresAt);审计 `support_access.granted`。 |
| `GET /api/support-access` | `support_access:view` | 本租户授权列表(active + 历史);分页 + status 过滤;RLS 限本租户。 |
| `GET /api/support-access/:id` | `support_access:view` | 单条授权详情。 |
| `POST /api/support-access/:id/revoke` | `support_access:revoke` | 撤销(`@HttpCode(200)`,reason 必填);审计 `support_access.revoked`。 |

**平台侧:受授权的只读支持访问**(`@Controller('api/platform/support')`,
`PlatformAuthGuard`;对带 `:tenantId` 的读再加 `SupportAccessGuard`):

| 方法 & 路由 | 守卫 | 说明 |
|---|---|---|
| `GET /api/platform/support/grants` | 平台身份 | 「哪些租户**指名我**授权了」——经 `app_list_support_grants_for_admin(本人 id)`(§3.6 的姊妹 SECURITY DEFINER 函数);不带租户上下文,只回自己的 grant 摘要。 |
| `GET /api/platform/support/tenants/:tenantId/audit-logs` (+ `/:id`, `/chain/verify`) | 平台身份 + 有效授权 | 只读被授权租户审计(复用 `AuditQueryService.list/getOne/verifyTenantChain`);每次审计 `support_access.accessed`。 |
| `GET /api/platform/support/tenants/:tenantId/users` , `/roles` | 平台身份 + 有效授权 | 只读被授权租户的用户/角色**配置**(复用 1H 读路径);每次审计 `support_access.accessed`。 |

> 平台命名空间用 `api/platform/support/...`(独立于 1K-A 的 `api/platform/tenants`),
> 使「受授权支持访问」与「租户生命周期」在路由上一眼可分、各自独立审计。

### 3.2 状态与生命周期(状态机,钉死)

- **授权(`support_access_grants`)采「租户主动授权、一步入 active」**:
  `∅ --grant(租户)--> active --revoke(租户)--> revoked`;`active` 在 `expires_at`
  到点后**派生失效**(读路径经 §2.4 函数的 `now() < expires_at` 即时判定,**不**落
  `expired`、**不**需后台清扫)。
  - **不走「平台申请→租户批准」两步流**:§2.2 表里 `pending` / `approved_at` 列
    **本阶段保留但不使用**(默认直接以 `active` 落库、`approved_at = now()`),为将来
    引入请求流预留,不引 dead state 进本阶段逻辑。
  - `expired` 同理:列举在 status CHECK 里(供将来清扫回填),本阶段无代码产生该值,
    有效性判定只信 §2.4 函数。
- **非法转换 → 409**:撤销一条已 `revoked` 的授权 → 409;撤销已派生过期(查得到但
  `now() >= expires_at`)→ 允许把 status 落 `revoked`(留痕),还是 409?**钉死:
  允许撤销**(撤销是收紧操作,幂等友好;但若已是 `revoked` 则 409)。

### 3.3 租户侧:授权端点(细节)

- **POST /api/support-access** — DTO `CreateSupportAccessDto`:
  `{ platformAdminEmail @IsEmail, reason @IsString @IsNotEmpty @MaxLength(500),
  scope @IsIn(['read_only']), expiresAt @IsISO8601(且解析后 > now()) }`,
  `whitelist + forbidNonWhitelisted`。服务端:
  1. 把 `platformAdminEmail` 解析为 `platform_admin_id`(查 `platform_admins`,
     `status='active'`);未知/停用 → **统一 404**(不泄漏平台管理员存在性)。
  2. 校验 `expiresAt` 在将来(过去 → 400)。
  3. 同 `(platform_admin_id, tenant_id)` 已有 `active` 行 → **409**(条款被冻结,
     改条款须先撤销;§4 钉死),否则 partial unique `uq_sag_one_active` 也会兜底。
  4. 在 `withTenantContext`(tenant_user)里 INSERT `active` 行
     (`granted_by_user_id = caller.sub`,`approved_at = now()`),COMMIT 后审计
     `support_access.granted`(租户链)。
- **GET 列表/详情** — RLS 限本租户;`dataScope = all`(授权是租户管理职能,授权记录
  不绑资源 owner,own-scope 对它无意义,§4 钉死);列表分页 + 可选 status 过滤,
  `created_at DESC`;详情 404 if 不存在/跨租户(RLS 空集)。
- **POST /:id/revoke** — DTO `{ reason @IsNotEmpty @MaxLength(500) }`。
  `SELECT … FOR UPDATE` 取该租户该 id 的行:不存在 → 404;已 `revoked` → 409;
  否则 UPDATE `status='revoked'`、`revoked_by_user_id=caller`、`revoked_at=now()`、
  `revoke_reason`,COMMIT 后审计 `support_access.revoked`(租户链)。冻结触发器
  (§2.3)保证只动 status/revoked_*,授权条款不可被改。

### 3.4 平台侧:受授权只读访问(核心机制,钉死)

**`SupportAccessGuard`**(在 `PlatformAuthGuard` 之后执行,挂带 `:tenantId` 的平台
路由):
1. 取 JWT 平台管理员 id(`user.sub`)+ 路由参数 `:tenantId`。
2. 调 §2.4 的 `app_check_support_access(adminId, tenantId)`(SECURITY DEFINER 窄
   校验,内建 `status='active' AND now() < expires_at`)。
3. **无有效授权 → 403**(默认拒绝);有则把 `{ grantId, scope }` 暂存到
   `request.supportGrant`,放行。
4. guard **绝不**取客户端传入的 adminId——只信 JWT 已认证的 `user.sub`(§4 越权护栏)。

**控制器据授权打开受限租户上下文,复用既有只读服务**:
- 平台侧只读控制器拿到 `request.supportGrant` 后,构造一个
  `RequestActor { userId: adminId, tenantId: <被授权租户>, dataScope: 'all' }`
  交给既有服务(`AuditQueryService.list/getOne/verifyTenantChain`、1H users/roles
  读)。这些服务内部走 `withTenantContext`,因此**业务读仍受 RLS** —— 天然只见被
  授权租户;`dataScope='all'`(支持需全租户只读视图,但只限该租户)。
  - 关键:`withTenantContext` 的 `actorType` 传 **`'platform_admin'`**(见
    `database/context.ts` 的 `ActorType` 已含此值),`userId` 传**平台管理员 id**
    —— 即在受限租户上下文里,会话身份诚实地标注「这是平台管理员」,**不**伪装成
    某个租户用户(§4 不冒名)。
  - 既有 `AuditQueryService.list` 的 own-scope 锚定 `actor_id`(1I 设计);此处用
    `all`,故不触发该锚定,平台只读看到该租户全量审计——这正是支持访问要的视图。
- 每次成功访问**写 `support_access.accessed`**(actor=`platform_admin`、
  `tenant_id`=被授权租户、`resourceId`=grantId、metadata `{ scope, resourceType,
  route }`),经既有 `audit_logs_system_insert`(§2.6)入**租户链** → 对租户可见。
  审计在**返回数据前**写(fail-closed:审计写失败则请求失败、不返回数据,呼应 1J
  导出的「audit BEFORE bytes」取舍——跨边界访问比普通读更需先留痕)。

**`scope=read_only` 由结构保证**:平台 `api/platform/support/...` 命名空间下**只挂
`GET`**,无任何写/改租户数据的路由 —— read_only 是「没有别的路可走」,而非仅靠
标志位。将来若需写能力,须**显式新增**写端点 + 扩 `scope` CHECK 取值 + 加独立护栏。

**设计抉择(钉死,承母规划 §3.5)**:用平台命名空间下的**专用只读端点**复用**服务
层**,而非「让既有租户端点也接受平台身份」——后者要改 `TenantAuthGuard` 的主体
类型,牵动面大、易错;专用端点让平台路径**显式、可独立审计、租户认证层零改动**,
代价是复用服务(非控制器),可接受。

### 3.5 与 1K-A(租户生命周期 + 全局闸门)的关系

- 1K-A 已落 `api/platform/tenants` 启停端点与 `TenantStatusMiddleware`,本阶段
  **不改**。
- **平台侧 support 端点不受租户状态闸门约束**(`TenantStatusMiddleware` 只拦**租户
  JWT**;平台 JWT 走 platform секрет、`type=platform_admin`,中间件 no-op 放行)。
- **停用(suspended/deactivated)租户能否被平台只读支持访问?钉死:允许** —— 排障
  常发生在停用之后,且该访问仍受「active grant + 限时 + 全程审计」约束,是受控的。
  `app_check_support_access` 只看 grant 有效性,不看 `tenants.status`,故天然允许。
- **被停用租户能否新建授权?**:授权端点是**租户侧**(`TenantAuthGuard`),会被
  1K-A 闸门拦截 —— 停用租户的用户根本登不进/被 403,故**自然无法新授权**(无需在
  本阶段额外加判定)。已存在的 active 授权不受租户停用影响(平台仍可据其只读)。

### 3.6 平台侧「我的授权」查询(无租户上下文)

`GET /api/platform/support/grants` 要在**无租户上下文**下列出「指名本管理员的所有
授权」(跨租户摘要)。与 §2.4 同模式,新增姊妹 SECURITY DEFINER 函数
`app_list_support_grants_for_admin(p_platform_admin_id uuid)`(pinned search_path),
**只**回该管理员被指名的 grant 摘要(`grant_id, tenant_id, scope, status,
expires_at`),不泄漏他人授权、不回任何业务数据。函数入参只取**服务端 JWT 的
`user.sub`**,绝不取客户端传参(§4 越权护栏)。
- 该函数与 `app_check_support_access` 同在 migration 037 创建(§2 已涵盖校验函数;
  实施时一并加这只列表函数,授予/REVOKE PUBLIC 同款)。
- 此端点本身是平台管理员看「自己手上有哪些授权」,**不**触达任何租户业务/审计数据,
  故**不**写 `support_access.accessed`(它没访问租户数据);列出动作不审计(同
  1I/1J「普通读不审计」)。

### 3.7 dataScope / 隔离小结

- **租户侧授权端点**:RLS 限本租户 + `support_access:*` 权限;dataScope `all`。
- **平台侧据授权只读**:无授权 → 403 一无所获(SECURITY DEFINER 校验 + 默认拒绝);
  有授权 → 仅该租户、只读、限时、**每次访问留痕**;走既有 RLS,不绕。
- **跨租户**:租户 A 用户经 RLS 永远看不到租户 B 的授权;平台管理员只看**指名自己**
  的授权(两只 SECURITY DEFINER 函数都按服务端 JWT 的本人 id 取数)。

### 3.8 不做的端点(承 §1.3)

- 无平台侧租户**业务数据**(客户/订单/金额/提成)只读端点——本阶段平台只读限于
  **审计 + 用户/角色配置**;业务数据的受授权只读作为后续**审慎扩面**(往本节白名单
  **显式加端点**,而非默认开放)。
- 无任何平台→租户**写**端点(scope 仅 `read_only`)。
- 无 impersonation / 代登录端点(不签租户 token)。
- 无「平台申请→租户批准」请求流端点(本阶段租户主动授权;`pending` 列预留)。
- 无后台到期清扫端点(到期使用时校验)。
- 租户生命周期端点与全局闸门**已属 1K-A**,本阶段不新增、不改。

## 4. 安全护栏与审计

本阶段跨越平台/租户身份边界,是迄今最敏感的一块。护栏重心:**客户授权是唯一入口、
默认拒绝、平台永不冒名、授权条款不可篡改、跨租户不可越权、全程对租户可见留痕**。
所有判定**服务端强制**(CLAUDE.md §4,绝不仅靠 UI 隐藏)。本节钉死 §1–§3 推来的
待定项:落哪条链、action 命名与 metadata、重复授权处置、停用租户下平台只读是否放行、
平台是否细分子权限。

### 4.1 护栏(服务端强制)

1. **客户授权是唯一入口 + 默认拒绝(核心)**:平台**不能自授**对租户业务数据的访问;
   每次平台只读都要求一条**租户授权、active、未过期、且指名本管理员**的 grant,
   `SupportAccessGuard` 经 §2.4 的 `app_check_support_access` 校验,**无有效授权一律
   403** —— 无 grant 则不打开任何租户上下文,什么都取不到。
2. **平台永不冒名(核心)**:平台一切动作在审计里 `actor_type='platform_admin'`、
   `actor_id=平台管理员 id`;受限租户上下文里 `withTenantContext` 的 `actorType` 也
   传 `'platform_admin'`、`userId` 传平台管理员 id(§3.4)——**不签发租户用户
   token、不冒充租户用户**。租户在 1I 里看到的永远是「平台管理员(非本租户用户)」:
   `actorName` 经 users 联表**解析不到**(平台管理员不在 users 表),回退显示
   `actorId` + `platform_admin` 标签,这正是「可辨认是平台在访问」的预期。
3. **授权条款不可篡改**:§2.3 的冻结触发器锁死 `reason`/`scope`/`expires_at`/
   `platform_admin_id`/`tenant_id`/`granted_by_user_id` —— 授权后不能被**悄悄放大
   范围或延长时限**;要改条款只能撤销后重新授权(留两条审计:revoked + granted)。
   `GRANT` 不含 DELETE(§2.3),凭证不删。
4. **最小授权 + 限时 + 范围(结构性)**:grant **指名具体管理员**(非「任意平台
   管理员」);`expires_at` 必填且在**使用时**经 §2.4 函数判定过期(派生失效,不靠
   清扫);`scope=read_only` 由「平台侧不存在任何写端点」**从结构上**保证(§3.4),
   非仅标志位;partial unique `uq_sag_one_active`(§2.3)保证同 (admin, tenant) 至多
   一条 active。
5. **跨租户不可越权**:两只 SECURITY DEFINER 函数(`app_check_support_access` /
   `app_list_support_grants_for_admin`)只接受**服务端 JWT 已认证的管理员 id**
   (`user.sub`),**绝不取客户端传参**;平台只看**指名自己**的授权;读租户 T 必须
   持**针对 T** 的 grant(`SupportAccessGuard` 逐请求按路由 `:tenantId` 校验);
   租户 A 用户经 RLS 永远看不到租户 B 的授权。
6. **租户隔离不被放大**:平台只读走**与租户用户相同的** `withTenantContext` + RLS,
   平台身份**不绕 RLS**,而是被授权后获得一个明确、限时的 `tenant_id`,因此天然只
   见被授权租户;dataScope 取 `all`(支持需全租户只读视图),但**仅限该租户**。
   本表 `support_access_grants` 自身 FORCE RLS(§2.3),租户侧端点也只见本租户授权。
7. **停用租户下平台只读仍放行(钉死)**:`app_check_support_access` 只看 grant 有效
   性、不看 `tenants.status`,故 suspended/deactivated 租户下,平台持有效 grant 仍可
   只读(排障常发生在停用之后,且受 grant + 审计约束,是受控的)。平台 support 端点
   不受 1K-A 全局闸门约束(闸门只拦租户 JWT,§3.5)。**被停用租户无法新授权**——
   授权端点是租户侧,租户用户已被 1K-A 闸门 403(§3.5),自然挡住,无需额外判定。
8. **RBAC 服务端强制 + 平台不细分(钉死)**:租户侧
   `support_access:grant/revoke/view` 由 `@RequirePermission` + `PermissionGuard`
   判定(默认仅 owner/管理员持有,§2.7 seed);**平台侧**受授权只读由**平台身份 +
   有效授权**双闸把关,本阶段**不**在平台管理员之间细分子权限(平台管理员是小而
   可信的集合,且**每个访问都审计**;子角色留后续)。
9. **重复授权 → 409(钉死)**:同 `(admin, tenant)` 已有 active 未过期 grant 时,
   再次授权返回 **409**(而非幂等静默)——因条款被冻结,改条款须先撤销;409 文案
   引导「先撤销现有授权」(partial unique 也兜底为 23505,服务端先查先报更友好的
   409)。非法状态转换(撤销已 revoked)同样 409。
10. **输入校验 + 防注入 + 不泄漏存在性**:DTO `whitelist + forbidNonWhitelisted`;
    `platformAdminEmail @IsEmail`(服务端解析为 id,未知/停用 → **统一 404**,不
    泄漏平台管理员是否存在);`expiresAt` 必须为将来(过去 → 400);
    `scope @IsIn(['read_only'])`;所有查询参数化下推(无字符串拼接)。
11. **不可篡改设施不被削弱**:本阶段**不动任何 `audit_logs` policy**(§2.6 已论证
    无需新增)、REVOKE UPDATE/DELETE(023)、拒改触发器(022)、哈希算法/`hash_version`/
    链结构一律不动;平台事件经既有 `audit_logs_system_insert`(§2.6)混入租户链后,
    `verifyChain(tenant:<id>)` 照常 PASS(1K-A 已实证同机制可 PASS)。
12. **SECURITY DEFINER 最小暴露**:两只校验函数 `SET search_path = pg_catalog,
    public`(防劫持,029 教训)、`REVOKE EXECUTE FROM PUBLIC` + 仅 `GRANT … TO
    kirindesk_app`(§2.4),且只回授权摘要/grantId,绝不回租户业务数据。
13. **fail-closed 审计(跨边界读)**:平台 `support_access.accessed` 在**返回数据前**
    写(§3.4);审计写失败 → 请求失败、不返回数据(比普通读更严,呼应 1J 导出的
    audit-before-bytes)。

### 4.2 审计(敏感操作必留痕,落链与形状钉死)

与 1I/1J 一致:普通读不审计,但**跨边界的平台只读是敏感访问 → 必审计**(同 1J 导出
的取舍)。全部经既有 `AuditService` 入既有链:

| action | actor_type | 落链 | resource_type / id | metadata(标识 + 摘要,无业务明文) |
|---|---|---|---|---|
| `support_access.granted` | tenant_user | **租户链** | support_access_grant / grantId | `{ platformAdminId, scope, expiresAt }`(reason 走审计的 `reason` 字段) |
| `support_access.revoked` | tenant_user | **租户链** | support_access_grant / grantId | `{ platformAdminId }`(revoke reason 走 `reason` 字段) |
| `support_access.accessed` | platform_admin | **租户链**(经既有 system_insert policy) | support_access_grant / grantId | `{ scope, resourceType, route }` |

- **一律落租户链**:让客户在 1I 审计查看器看到「谁(平台管理员)在何时、凭哪条授权
  (grantId)、为何(reason)、访问/改动了什么」——这是本阶段的核心信任价值点。
- **reason 用审计的 `reason` 字段**:`AuditLogParams.reason`(既有)承载授权/撤销的
  目的说明(治理证据),非业务明文;`metadata` 只记标识 + 授权条款摘要 + 访问的
  资源类型/路由,**绝不**记被读到的逐行业务数据。
- **`platform_admin_id` / `granted_by_user_id` 入 metadata 是标识符不是业务数据**:
  与 1H/1I 一贯做法一致(审计记 id + diff,不记敏感明文)。
- **`.accessed` 的噪声(已知)**:本阶段**每次访问请求记一条**(翻页多次读=多条);
  按会话/时间窗聚合去噪作为后续优化(同 1I 对读审计的取舍),先求**不漏记**。
- **谁来写 `.accessed`**:平台只读控制器在调既有只读服务取数**之前**先
  `auditService.log({...})`(`tenantId=被授权租户`、`actorType='platform_admin'`、
  `actorId=adminId`、`resourceId=grantId`),经既有 `audit_logs_system_insert`
  (AuditService session actor=system)落租户链。
- **不改写入路径**:`AuditService`、哈希、`hash_version`、链结构、append-only
  约束一律不动(§2.6/§2.8)。

### 4.3 验证这些护栏(集成/单元覆盖,详列 §6)

- **默认拒绝**:平台无 grant 读租户数据 → 403;**过期** grant → 403;**已撤销** →
  403;**active 有效** → 200 且写一条 `support_access.accessed`(落租户链)。
- **跨租户**:针对 T1 的 grant 不能读 T2(403);平台 `support/grants` 列表只含
  指名自己的;租户 A 用户看不到租户 B 的授权(RLS 空集 → 404/空)。
- **不可篡改**:对 grant 的 `reason`/`scope`/`expires_at`/`platform_admin_id` 做
  UPDATE → 冻结触发器拒绝(仅 status/revoked_*/approved_at/updated_at 可改);
  DELETE 被 GRANT 收口拒绝(无 DELETE 授予)。
- **不冒名**:`granted`/`revoked` 事件 `actor_type=tenant_user`,`accessed` 事件
  `actor_type=platform_admin`;全程无租户用户 token 签发;受限上下文 `actorType=
  platform_admin`。
- **停用租户**:suspended 租户下平台持有效 grant 仍可只读(200 + 审计);该租户的
  租户用户仍被 1K-A 闸门 403(故无法新授权)。
- **RBAC**:无 `support_access:grant` 的租户用户 POST 授权 → 403(并命中既有
  `rbac:permission_denied` 留痕);无 token → 401。
- **审计→租户链 + 链完整**:平台访问后,**租户**在 1I 能看到该
  `support_access.accessed`;`verifyChain(tenant:<id>)` 仍 PASS。
- **409 / 404 / 400 校验**:重复 active 授权 → 409;撤销已 revoked → 409;未知/停用
  `platformAdminEmail` → 404;过去时间 `expiresAt` → 400。
- **SECURITY DEFINER 越权**:函数只认服务端传入的 JWT adminId;构造「读他人 grant」
  的尝试取不到行(函数按本人 id 过滤)。

## 5. 前端页面与导航

本阶段前端横跨**两个身份面**:① **租户侧**(既有 web app,tenant-jwt
`kd_access_token`)——客户授权/撤销/查看支持访问的管理页,是「客户授权」基石的落点,
与 1I 审计查看器闭环;② **平台侧**(platform-jwt)——既有 web app **至今无任何平台
界面**(1K-A 的 `api/platform/tenants` 与本阶段的 `api/platform/support/*` 都还是
admin-API only),需引入**第二套鉴权**(独立 token + 独立路由树/布局)才能在浏览器里
真正使用。两块都复用既有 `request<T>()`(`apps/web/src/lib/api-client.ts`)/ `ApiError`
按 status 映射 / 行内 `CSSProperties` 中文 / 服务端 403 优雅降级约定,无新依赖。

> **体量提示 + 建议再拆**:租户侧管理页落在既有 app、小而低风险,是本阶段前端**主
> 交付**(§5.1);平台控制台需引第二套鉴权(独立存储键、独立 401 处理、独立布局),
> 是更重的一半(§5.3)。**建议实施时再拆**:**1K-B-1 = 租户侧管理页 + 1I 可见性闭环**
> (后端 §3.1 租户侧端点已足够支撑,可独立交付价值);**1K-B-2 = 平台控制台**
> (含登录/我的授权/受授权只读视图,并顺带补 1K-A 缺的租户生命周期管理页)。本节把
> 两者都规格化,拆分与否在实施前定。

### 5.1 租户侧:支持访问管理页(主交付,cornerstone)

`apps/web/src/support-access/SupportAccessPage.tsx`(路由 `/support-access`),供租户
owner/管理员:

- **授权列表**:表格列 = 平台管理员(邮箱/标识)、范围(read_only)、**有效状态**、
  授权人、到期时间、创建时间、操作。**有效状态在前端按 `expires_at` 派生**——后端
  存储态本阶段只产生 active/revoked(§3.2),页面对 `active` 且 `expires_at < now()`
  的行显示「已过期」(灰),`active` 未过期显示「生效中」(绿),`revoked` 显示
  「已撤销」(灰)。
- **新建授权**(草稿态表单 → 提交):平台管理员邮箱、原因(必填)、范围(read_only,
  本阶段唯一值,可固定展示)、到期时间(`<input type="datetime-local">`,默认给一个
  短时窗如 24h);提交调 `POST /api/support-access`;未知/停用邮箱 → 404 文案、重复
  active → 409 文案(引导「先撤销现有授权」)、过去时间 → 400 文案,均内联不崩页。
- **撤销**:仅「生效中」行可撤销,点击 → 填撤销原因(必填) → `POST
  /api/support-access/:id/revoke`;撤销后行变「已撤销」。
- **整页 403 降级**:无 `support_access:view` → 整页「没有权限管理支持访问」(同
  reports/audit 页约定;`/api/auth/me` 不带权限码、UI 隐藏非安全边界 §4)。
- **隐私**:授权内容只在 React state;不写 localStorage/sessionStorage/URL/console
  (§6 浏览器 spot-check)。

### 5.2 租户侧:平台访问的可见性(复用 1I,无新页面)

支持访问事件都落**租户链**(§4.2),因此租户在既有 **1I 审计查看器**
(`/audit-logs`)即可看到 `support_access.granted/.revoked/.accessed`(以及 1K-A 的
`tenant.suspended/.activated/.deactivated`)——**无需新页面**。`SupportAccessPage`
顶部给一个跳转链接到 `/audit-logs`(可带预过滤 `action=support_access.accessed`),
把「平台何时访问了我」直接引到审计页。这正是 1I/1J/1K 的信任闭环:授权在此页发生、
访问在审计页可查。

### 5.3 平台侧:平台控制台(第二套鉴权,较重一半 / 建议 1K-B-2)

平台管理员经 `/api/platform-auth/login`(邮箱 + 密码,**无 tenantSlug**)登录;既有
web app **尚无**平台界面,故新增一个**与租户 app 隔离**的最小控制台:

- **登录 + 鉴权**:`/platform/login` → platform-jwt 存于**独立存储键**
  `kd_platform_token`(与租户 `kd_access_token` 严格分开)→ `PlatformAuthContext` +
  `PlatformProtectedRoute` + 极简 `PlatformLayout`(导航:租户 / 我的授权)。**刻意
  与租户 app 的 `AuthContext`/`ProtectedRoute`/`AppLayout` 路由树分离**,避免两套
  身份混淆(§4 不冒名)。
- **我的授权页** `PlatformGrantsPage`(`/platform/support-grants`):「哪些租户**指名
  我**授权了」——调 `GET /api/platform/support/grants`(§3.6),列出租户/范围/状态/
  到期;点击进入受授权租户的只读视图。
- **受授权只读视图** `PlatformTenantViewPage`(`/platform/support/tenants/:tenantId`):
  **只读**呈现被授权租户的审计 / 用户 / 角色(数据走平台端点 §3.1,复用既有列表
  渲染);页顶**醒目横幅**「你正以平台支持访问身份**只读**查看租户 X(范围
  read_only,到期 …);此访问已被记录并对该租户可见」;**无任何写控件**
  (scope=read_only,§3.4)。无有效授权 / 已过期 → 403 整页提示(后端
  `SupportAccessGuard` 已 403,前端忠实呈现)。
- **(顺带)租户生命周期管理页** `PlatformTenantsPage`(`/platform/tenants`):1K-A 的
  `api/platform/tenants` 启停/列表端点目前**无 web UI**;平台控制台一旦存在,这是它
  的自然归处——租户清单(name/slug/status/created,**无业务数据**)+ suspend/activate/
  deactivate(需填原因,409 文案)。**列为 1K-B-2 顺带项,非支持访问核心**,可视
  排期纳入或单列。

### 5.4 api-client / 类型扩展

- **租户侧**(随 §5.1):在既有 `apiClient` 加 `createSupportGrant` /
  `listSupportGrants` / `getSupportGrant` / `revokeSupportGrant`(走既有
  `request<T>()`,自动带 `kd_access_token`);`lib/types` 加 `SupportGrant`(派生
  effective 状态由前端算)、`CreateSupportGrantInput` 等。
- **平台侧**(随 §5.3):新增一个**并行的 `platformRequest<T>()`**——与 `request<T>()`
  同构,但读/写**独立的 `kd_platform_token`**,401 走**平台登出**(清平台键 + 跳
  `/platform/login`)而非租户登出。这是本阶段前端**最主要的新增复杂度**,须与租户
  token 严格隔离(不同存储键、不同 401 钩子)。配套平台方法:`platformLogin` /
  `listMyGrants` / `platformTenantAuditLogs(+getOne/+verifyChain)` /
  `platformTenantUsers` / `platformTenantRoles` /(顺带)`listTenants` /
  `setTenantStatus`。
- 受授权只读视图复用 1I 的 `AuditLogSummary/Detail`、1H 的 user/role 类型;只是 base
  路径换成 `api/platform/support/tenants/:tenantId/...`,可把列表渲染抽成参数化组件
  最大化复用(实施时定)。

### 5.5 导航与路由

- **租户侧**:`App.tsx` 受保护布局(`ProtectedRoute` → `AppLayout`)下加
  `<Route path="/support-access" element={<SupportAccessPage/>}/>`;`AppLayout` 加
  导航「支持访问」(always-show + 服务端 403 优雅降级,同既有约定)。
- **平台侧**:**独立路由子树** `/platform/*`(`/platform/login` 公开,其余经
  `PlatformProtectedRoute` + `PlatformLayout`),**不**进 `AppLayout` 导航——两套
  身份的入口、布局、登出彼此独立。

### 5.6 只读 / 隐私 / 降级约定

- **租户页**:无业务数据展示;授权/撤销为仅有的写动作,均带原因、即时反映;403
  整页降级,其他错误内联。
- **平台只读视图**:**零写控件**(read_only);每个视图横幅声明「访问已被记录」;
  只展示**授权范围内**的数据(本阶段=审计 + 用户/角色配置,非业务数据,§3.8)。
- **隐私 spot-check**(浏览器 QA §6):两面页面源 grep 零 `console.*`、敏感内容不落
  localStorage/sessionStorage/URL(token 沿用 app 既有 localStorage 方式,但平台
  token 用**独立键** `kd_platform_token`);内容刷新即重新拉取,不缓存到持久层。
- **纯加法、无新依赖**:租户页是既有 app 内新增;平台控制台是新文件 + 第二套鉴权,
  但**不引第三方库**。

## 6. 测试

后端以 **vitest 集成测试**为主(`apps/api/test/support-access.integration.test.ts`,
supertest 打真实 HTTP,跑在 `kirindesk_test`,复用 `setup-integration` + `fixtures`),
覆盖跨边界授权 / 默认拒绝 / 受限上下文 / 隔离 / 审计落租户链;状态机与
`SupportAccessGuard` 走**单元测试**;前端走浏览器 QA(Playwright,两套身份)。提交
前置仍是 `pnpm verify` 全绿。本阶段**有迁移(037)**,故另需迁移可逆性校验。

### 6.1 测试前置:fixture / 迁移

- **迁移自动应用**:`setup-integration` 已跑 `pnpm --filter @kirindesk/database
  migrate` 全量应用,037 随之建表 / RLS / 索引 / 冻结触发器 / 两只 SECURITY DEFINER
  函数;无需手动建。**额外校验**可逆:`migrate → rollback 037 → migrate` 干净往返
  (§8)。
- **RBAC 码补授(测试 fixture,非产品 seed)**:在 `fixtures.ts` 的 `SEED_PERMS` 加
  `SUPPORT_ACCESS_PERMS = ['support_access:grant','support_access:revoke',
  'support_access:view'].map(code => ({ code, moduleId: SYSTEM_MODULE_ID }))`(挂
  `SYSTEM_MODULE_ID`,与 audit/tenant-settings 同模块),授予 `ADMIN_ROLE_ID`
  (scope=all);**TEST_USER2(sales)/ TEST_USER4(no-role)不授**,用于 403。同 1J
  做法,不改产品 seed、不引 migration。
  > 产品侧的等价 seed(§2.7)单独落,fixture 这份只为测试鉴权;两者不耦合。
- **平台管理员已就绪**:fixture 已 seed `platform_admins`(`TEST_ADMIN_ID` /
  `TEST_ADMIN_EMAIL` / `TEST_PASSWORD`);测试经 `POST /api/platform-auth/login`
  `{ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD }` 取 platform token(既有
  ai/files 测试已是此用法),据其据授权访问。
- **两个租户已就绪**:`TEST_TENANT_ID`(含 admin/sales/no-role 用户)与
  `TEST_TENANT2_ID`(含 admin)用于跨租户隔离断言;无需新增第三租户(1K-B 不涉及
  停用共享库——租户停用属 1K-A,本阶段不碰,§3.5)。

### 6.2 集成测试用例(support-access.integration.test.ts)

**租户侧授权(tenant-jwt)**

- create:admin(`support_access:grant`)`POST /api/support-access`
  `{ platformAdminEmail: TEST_ADMIN_EMAIL, reason, scope:'read_only',
  expiresAt: 未来 }` → 201、status `active`、`granted_by_user_id=admin`、
  `approved_at` 非空;审计 `support_access.granted` 入 **TEST_TENANT 链**。
- 未知 `platformAdminEmail` → **404**(不透明,不泄漏平台管理员存在性);过去
  `expiresAt` → **400**;`scope` 非 `read_only` → **400**;多余字段 → 400
  (`forbidNonWhitelisted`)。
- 重复 active(同 admin+tenant 未过期)→ **409**。
- list / get(`support_access:view`):返回本租户授权;RLS 限本租户;跨租户 id →
  404(RLS 空集)。
- revoke(`support_access:revoke`,reason 必填):status→`revoked`、写
  `revoked_by_user_id/revoked_at/revoke_reason`;审计 `support_access.revoked`;
  再撤销同一条 → **409**;无 reason → 400。
- RBAC:`TEST_USER2`(sales,无 support_access 码)/ `TEST_USER4`(无角色)POST →
  **403**(并命中既有 `rbac:permission_denied` 留痕);无 token → **401**。

**冻结触发器 + append-only(DB 层,经 owner/superuser 连接)**

- 对一条 grant 直接 `UPDATE reason/scope/expires_at/platform_admin_id/tenant_id/
  granted_by_user_id` → 触发器 **RAISE**(拒绝);仅 `status`/`revoked_*`/
  `approved_at`/`updated_at` 可改(仿 022/023/034 不可变断言写法)。
- `DELETE FROM support_access_grants` 经 `kirindesk_app` 角色 → 被拒(无 DELETE
  授予,§2.3);凭证不可删。

**平台侧受授权只读访问(核心,platform-jwt)**

- **无授权** → platform `GET /api/platform/support/tenants/:T/audit-logs` →
  **403**(默认拒)。
- 租户为 `(TEST_ADMIN, TEST_TENANT)` 建 active 授权后,platform `GET …/audit-logs`
  → 200、返回 **TEST_TENANT 的**审计(复用 `AuditQueryService`,dataScope=all),
  并写一条 `support_access.accessed`(actor=`platform_admin`、`resourceId=grantId`、
  入 **TEST_TENANT 的链**);**租户**随后能在自己的 1I 审计列表看到它。
- 同理覆盖 `…/users`、`…/roles`、`…/audit-logs/:id`、`…/audit-logs/chain/verify`
  各写一条 `.accessed`。
- **过期授权 → 403**:`expiresAt` 创建时必须为未来且冻结触发器禁改,故测试**经 owner
  连接直接 INSERT** 一条 `expires_at` 在过去的 grant(INSERT 不被 BEFORE UPDATE
  触发器拦),再 platform GET → 403(`app_check_support_access` 的 `now()<expires_at`
  生效)。**已撤销 grant → 403**。
- **跨租户**:针对 `TEST_TENANT` 的授权不能读 `TEST_TENANT2`(GET T2 → 403);
  `GET /api/platform/support/grants` 只含**指名 TEST_ADMIN**的授权(给 T2 的 admin
  建的、或指名别的平台管理员的都不出现)。
- **scope=read_only 结构性**:断言平台 `api/platform/support/*` 下**不存在**任何
  写 / 改租户数据的路由(对一个只读路径发 POST/PATCH → 404/405)。
- **平台端点须平台 token**:用租户 token 打平台 support 端点 → 401/403;无 token →
  401。
- **不受租户状态闸门**(§3.5):平台 support 端点不被 `TenantStatusMiddleware` 拦
  (它只认租户 JWT);此处断言平台 token 正常放行(本用例不触碰租户停用,停用属
  1K-A)。

**审计落租户链 + 链完整**

- granted / revoked / accessed 后,**以租户身份**查 1I 列表 → 各事件在位、
  `actor_type` 正确(`accessed=platform_admin`,`granted/revoked=tenant_user`);
  `verifyTenantChain`(经 `/api/audit-logs/chain/verify` 或服务)对 TEST_TENANT 链
  仍 **PASS**;`.accessed` 的 metadata 仅 `{scope,resourceType,route}`、**无业务
  明文**,reason 在审计 `reason` 字段。

**SECURITY DEFINER 校验隔离**

- `app_check_support_access(adminId, tenantId)` 只对**有效 active 未过期、且指名
  adminId** 的授权返回行;`app_list_support_grants_for_admin(adminId)` 只回指名
  adminId 的 grant —— 传 B 的 id 拿不到指名 A 的授权(直接 SQL 或经端点断言)。

### 6.3 单元测试(轻量)

- **授权状态机**(若抽成纯函数):`active→revoked` 合法;`revoked→revoked` 非法
  (409);对已派生过期者再撤销 → 允许落 `revoked`(§3.2 钉死)。
- **`SupportAccessGuard`**:mock `app_check_support_access` → 有效 grant 放行并把
  `{grantId,scope}` 挂到 request、无 / 过期 / 撤销 → 403;断言它只用**已认证的
  平台管理员 `user.sub`**(不取客户端传参 / 路由外的 id)。
- **email→id 解析**:未知 / 停用平台管理员 → 统一不透明 404(不泄漏存在性)。
- **CSV/钱无关**:本阶段无金额计算,无需 money 单测。

### 6.4 前端浏览器 QA(Playwright + 真实 Chromium,两套身份)

- **租户侧**(`kd_access_token`):登录 admin → `/support-access`:填平台管理员邮箱
  建授权 → 列表显示「生效中」→ 撤销 → 「已撤销」;跳 `/audit-logs` 见
  `support_access.granted/.revoked`;无 `support_access:view` 用户 → 整页
  「没有权限管理支持访问」。
- **平台侧**(`kd_platform_token`,§5.3 若纳入本批):`/platform/login` 以
  `TEST_ADMIN` 登录 → 「我的授权」显示租户刚建的授权 → 进入受授权租户只读视图:见
  「访问已被记录」横幅、只读审计 / 用户 / 角色、**无写控件**;回租户侧 1I 确认产生了
  `support_access.accessed`(对租户可见)。无有效授权 → 403 整页。
- **隐私 spot-check**:两面页面源 grep 零 `console.*`、敏感内容不落 localStorage /
  sessionStorage / URL;平台 token 存于**独立键** `kd_platform_token`、与租户
  `kd_access_token` 隔离。
- 截图留证(租户授权 / 撤销、我的授权、受授权只读视图 + 横幅、两类 403)。
- **若平台控制台按 §5.3 拆到 1K-B-2**:本批浏览器 QA 只覆盖租户侧;平台侧后端用例
  (§6.2)经 supertest 已完整覆盖其数据路径(同 1G 无头浏览器缺位时的处置)。

### 6.5 质量门槛

- `pnpm verify` 全绿:lint / format / typecheck / build / unit(+ 本阶段状态机 / 守卫
  单测)/ integration(现有 + support-access 用例,DB 已含迁移 037)/ security 13。
- **迁移可逆**:`037` up / down / up 干净往返(§8);down 后无悬挂对象(表 / RLS
  policy / 索引 / 冻结触发器 + 其函数 / 两只 SECURITY DEFINER 函数 / CHECK 全净
  移除)。
- (可选)安全回归脚本追加:`support_access_grants` 冻结触发器拒改授权条款、
  `kirindesk_app` 无 DELETE 授予、两只 SECURITY DEFINER 函数 `REVOKE EXECUTE FROM
  PUBLIC` —— 作为「不削弱不可篡改 / 最小暴露」的静态 / DB 断言。
- **不动审计设施的回归**:既有 security 13(含 `UPDATE/DELETE audit_logs` 被拒)
  保持绿,证明本阶段未触碰审计 append-only(§2.6)。

## 7. 风险与回滚

本阶段是迄今**风险最高**的一支:跨平台/租户身份边界、**有迁移(037)**、新增两只
SECURITY DEFINER 函数、并引入**第二套前端鉴权**(平台控制台)。与母规划设想不同,本
阶段**不**新增 `audit_logs` INSERT policy(§2.6:复用既有 `audit_logs_system_insert`)、
也**不**引入全局租户状态闸门(已于 1K-A 落地)。风险因此集中在「平台访问越权」「DEFINER
越权面」与「两套前端鉴权混淆」。

### 7.1 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **平台越权读到未授权租户数据(最高)** | 高 | 客户授权是唯一入口 + 默认拒绝;`SupportAccessGuard` 逐请求按路由 `:tenantId` + JWT 管理员 id 经 `app_check_support_access` 校验**有效 active 未过期**授权,无效即 403;平台读走 `withTenantContext` + RLS(不绕过),只见被授权租户;`scope=read_only` 由「无任何平台写端点」结构性保证(§3.8);集成测试钉死 无/过期/撤销/跨租户 → 403(§6.2)。 |
| **SECURITY DEFINER 函数成为越权/注入面** | 中-高 | `app_check_support_access` / `app_list_support_grants_for_admin` 只接受**服务端传入的已认证管理员 id**(绝不取客户端参 / 路由外 id)、只回最小列、无有效配对则一无所获;**pin `search_path = pg_catalog, public`**(同 migration 029),防 search_path 劫持;`GRANT EXECUTE` 仅给 `kirindesk_app`、`REVOKE EXECUTE FROM PUBLIC`;code review 红线。 |
| **第二套前端鉴权与租户 token 混淆** | 中 | 平台 token 独立存储键 `kd_platform_token` + 独立 `platformRequest`/路由树/Context + 独立 401 处理;后端守卫按 token 类型各自拒绝(平台端点要 platform-jwt、租户端点要 tenant-jwt),即便前端串了也被服务端挡下;§5.3 建议把平台控制台拆到 1K-B-2,降低单批次表面积。 |
| **迁移触及关键表(无)/ 新表加法** | 中 | 037 全为**加法**:仅新建 `support_access_grants`(+ 其索引/RLS/冻结触发器)与两只 DEFINER 函数,**不动** `audit_logs`(无新 policy)、**不动** `tenants`(状态 CHECK 属 1K-A 的 036);可逆 up/down、down 为净移除;CI 校验 up/down/up 干净往返(§6.5)。 |
| **冻结/撤销语义遗漏**(条款被改 or 撤销后仍生效) | 低-中 | 冻结触发器锁死 reason/scope/expires_at/admin/tenant(§2.3);有效性 = active ∧ 未撤销 ∧ 未过期,三者缺一即拒(§3.2);测试覆盖 改条款被拒 + 重复撤销 409 + 过期/撤销→403。 |
| **`.accessed` 审计噪声**(翻页多读=多条) | 低 | 本阶段每访问一记、求不漏;按会话/时间窗聚合去噪留后续(同 1I `audit.viewed` 取舍)。 |
| **read_only + 受限读集「不够用」诱发未审查扩面** | 低(过程风险) | 扩读集是**显式加端点 + 评审**的刻意动作(§3.8),非配置开关;白名单式增长。 |
| **过期授权以 active 滞留(无清扫)** | 低 | 有效性处处**派生**(守卫经 DEFINER 函数 + 前端按 expires_at 现算);后台清扫留后续;测试钉死过期→403。 |
| **审计落不进链**(目标租户无 `audit_log_chains` 行) | 低 | 既有 AuditService 行为(无链行则静默 no-op);所有 seed/真实租户均有链行;待租户开通服务落地时须插入链行(1K-A 已记此设计债,本阶段不引入新缺口)。 |

### 7.2 回滚方案

本阶段**含迁移 037 + 产品 seed 增量(RBAC 码)+ 后端模块/守卫 + 两个前端面**,回滚
分层但仍干净:

- **数据库(migration 037)**:`rollback` 反向执行——丢弃 `support_access_grants`
  (及其索引/RLS policy/冻结触发器及其函数)、删两只 SECURITY DEFINER 函数。down 为
  **净移除、无需对账**:丢的只是**授权记录**(授权凭证,非业务数据);而这些授权
  产生的**审计事件(granted/revoked/accessed)留在 `audit_logs`**(append-only,
  删不掉也不该删)——即**回滚后留痕仍在、链仍 PASS**。**不触碰 `audit_logs`**
  (无新 policy 可删)**与 `tenants`**(其 CHECK 属 1K-A)。
- **产品 seed(RBAC 码)**:`support_access:grant/revoke/view` 若已入产品权限字典,
  端点撤除后即**失效空码**,无害;按需在 seed 回退中删除(幂等)。
- **后端**:支持访问租户侧 + 平台侧只读访问模块/控制器/`SupportAccessGuard`/服务
  ——`git revert`,净移除。**不涉及全局闸门**(属 1K-A,独立存废)。
- **前端**:租户支持访问页 + 平台控制台(含第二套 Context/路由/`kd_platform_token`)
  + 路由/导航——`git revert`,净移除。
- **子阶段粒度**:§5.3 的 1K-B-1(租户侧 + 平台只读后端)/ 1K-B-2(平台控制台前端)
  切分让两半可独立回退——后端 supertest 已完整覆盖平台只读数据路径,故即便 1K-B-2
  尚未上线 / 被回退,平台访问的安全契约仍由 1K-B-1 后端用例钉死(同 1G 无头浏览器
  缺位时的处置)。
- **不可篡改性与既有数据不受影响**:支持访问只读、从不写业务数据;无论装上还是回退,
  `audit_logs`/链/业务表原样不动,`verifyChain` 结论不因本模块存废而变。

## 8. 验证命令与验收标准

### 8.1 验证命令

**完整质量门槛(提交前置)**

```bash
pnpm verify          # lint + format:check + typecheck + build + unit + integration + security 13
```

**分步 / 定向(开发中)**

```bash
# 仅本模块集成测试
pnpm --filter @kirindesk/api test:integration -- support-access
# 仅状态机 / 守卫单测
pnpm --filter @kirindesk/api test:unit -- support-access
# 自动修格式(本仓约定:静默修,绿了再报告)
npx prettier --write "apps/api/src/**/*support*.ts" \
  "apps/web/src/support-access/**/*.tsx" "apps/web/src/platform/**/*.tsx"
# 前端类型 + 构建
pnpm --filter @kirindesk/web build
```

**迁移可逆性(本阶段有迁移 037)**

```bash
# up → down 037 → up 干净往返;down 后无悬挂对象
pnpm --filter @kirindesk/database migrate
pnpm --filter @kirindesk/database rollback   # 反向到 037 之前
pnpm --filter @kirindesk/database migrate
# 校验对象存在性(up 后应有、down 后应无):
#   表 support_access_grants、其 3 条 RLS policy / 3 个索引(含 partial unique
#     uq_sag_one_active)/ 冻结触发器 trg_sag_freeze_immutable + 函数 sag_freeze_immutable、
#   两只 SECURITY DEFINER 函数 app_check_support_access / app_list_support_grants_for_admin
# 不应触及:audit_logs(无新 policy)、tenants(其状态 CHECK 属 1K-A 的 036)
```

**本地冒烟(两套身份;⚠️ 本阶段不停用任何租户——停用属 1K-A;勿碰 dev-tenant 业务数据)**

```bash
# 租户侧:授权 → 列表 → 撤销
TOK=$(curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"dev-password-123","tenantSlug":"dev-tenant"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
GID=$(curl -s -X POST localhost:3001/api/support-access -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"platformAdminEmail":"<平台管理员邮箱>","reason":"排障","scope":"read_only","expiresAt":"<未来ISO>"}' \
  | sed -E 's/.*"id":"([0-9a-f-]{36})".*/\1/')
curl -s -H "Authorization: Bearer $TOK" localhost:3001/api/support-access            # 列表见 active
curl -s -X POST localhost:3001/api/support-access/$GID/revoke -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"reason":"排障完成"}'                       # → revoked
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3001/api/support-access/$GID/revoke \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"reason":"重复"}'  # → 409

# 平台侧(平台管理员凭据见 dev seed / .env;登录无 tenantSlug):我的授权 / 受授权只读
PTOK=$(curl -s -X POST localhost:3001/api/platform-auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<平台管理员邮箱>","password":"<平台密码>"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s -H "Authorization: Bearer $PTOK" localhost:3001/api/platform/support/grants  # 只列指名本人的授权
# 无有效授权 → 403;有效授权 → 200(只读该租户审计)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PTOK" \
  "localhost:3001/api/platform/support/tenants/<被授权租户id>/audit-logs"

# 链:平台只读访问后,被授权租户链仍 PASS(且新增 support_access.accessed)
pnpm db:verify-chain tenant:00000000-0000-0000-0000-000000000001
```

**前端浏览器 QA**:Playwright 跑 §6.4(两套身份),产出截图(租户授权/撤销、平台
「我的授权」、受授权只读视图 + 「访问已被记录」横幅、两类 403),并 grep 页面源做隐私
spot-check(零 `console.*`、敏感内容不入 storage/URL、`kd_platform_token` 独立键)。

### 8.2 验收标准(全部满足方算完成)

**后端 — 租户侧授权**

- [ ] `POST /api/support-access`、`GET /`、`GET /:id`、`POST /:id/revoke` 存在并按
      `support_access:grant/view/revoke` 守卫;无 token 401、无权 403、未知/停用平台
      管理员邮箱 → 统一 404、过去 `expiresAt` → 400、同对已有 active → 409、重复撤销
      → 409。
- [ ] 列表/详情 RLS 限本租户、跨租户 id → 404(空集);`dataScope=all`(授权不绑
      资源 owner);冻结触发器拒改授权条款(仅 status/revoked_* 可改)。

**后端 — 平台侧受授权只读**

- [ ] 平台 **无/过期/撤销** 授权读租户审计/用户/角色 → 403(默认拒绝);**有效** →
      200 且**仅**该租户、只读;跨租户(对未指名自己的租户)→ 403;
      `GET /api/platform/support/grants` 只列**指名本人**的授权摘要。
- [ ] `SupportAccessGuard` 只用**已认证平台 JWT 的 `user.sub`**(绝不取客户端 adminId)
      + 路由 `:tenantId`,经 `app_check_support_access` 校验;两只 SECURITY DEFINER 函数
      pin `search_path`、`REVOKE EXECUTE FROM PUBLIC`、仅 `GRANT EXECUTE TO kirindesk_app`;
      **scope=read_only** 由「平台 support 命名空间下只挂 GET、无任何写端点」结构性保证。

**审计**

- [ ] `support_access.granted/.revoked`(actor=`tenant_user`)与 `.accessed`
      (actor=`platform_admin`)全部落**被授权租户的链**;`.accessed` 在**返回数据前**
      写(fail-closed);metadata 仅标识 + 授权条款 / `{scope,resourceType,route}`,
      **无业务明文**;租户在 1I 可见;`verifyTenantChain` PASS;复用既有
      `audit_logs_system_insert`,**未新增 `audit_logs` policy**、未动哈希/append-only。

**迁移**

- [ ] `037` up 建齐(表 + 3 RLS + 3 索引 + 冻结触发器及函数 + 2 个 DEFINER 函数);
      **不触** `audit_logs` / `tenants`;down 全净移除;up/down/up 干净往返。

**测试与门槛**

- [ ] `pnpm verify` 全绿:含 support-access 集成 + 状态机/守卫单测;security 13/13。
- [ ] (可选)安全回归追加:冻结触发器拒改授权条款、`kirindesk_app` 无 DELETE 授予、
      两只 DEFINER 函数 `REVOKE EXECUTE FROM PUBLIC`;既有 security 13(含
      `UPDATE/DELETE audit_logs` 被拒)保持绿,证明未触碰审计 append-only。

**前端**

- [ ] 租户 `/support-access`:授权(平台管理员邮箱/原因/范围/到期)+ 列表(**派生**
      生效中/已过期/已撤销)+ 撤销;无 `support_access:view` 整页 403;导航「支持
      访问」;可跳转 1I 看 `support_access.*` 留痕。
- [ ] 平台控制台(§5.3,若纳入本批 / 否则 1K-B-2):独立 `/platform/login` + 布局 +
      独立 `kd_platform_token`;「我的授权」;受授权只读视图带「访问已被记录」横幅、
      **零写控件**;无有效授权 → 403。
- [ ] 隐私 spot-check:零 `console.*`、敏感内容不入 localStorage/sessionStorage/URL、
      平台 token 独立键 `kd_platform_token` 与租户 `kd_access_token` 隔离;纯加法、
      无新依赖。

**流程(CLAUDE.md §1/§9)**

- [ ] 实施前本规划(§1–§8)经用户确认;若按 §5.3 拆分(1K-B-1 租户侧 + 平台只读后端 /
      1K-B-2 平台控制台前端),分批推进、各自验收。
- [ ] 完成后按 §9 报告:新增 / 修改 / 删除文件、执行命令、测试结果、是否动 schema
      (**是:迁移 037**)、是否产生 secret(否)、遗留风险、建议下一步。

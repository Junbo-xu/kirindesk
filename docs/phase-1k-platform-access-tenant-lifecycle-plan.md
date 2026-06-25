# Phase 1K 规划 — 平台支持访问与租户生命周期(Platform Support Access & Tenant Lifecycle)

把 CLAUDE.md §3/§4 反复强调、却**完全未建**的两件信任核心补上:① 平台管理员对
租户业务数据的访问,从「无任何受治理通道」升级为「**须客户授权、带原因/范围/时限、
全程审计、默认拒绝**」的支持访问;② 租户 `status`(suspended 等)从「有列但无人
执行」升级为「全局生命周期闸门强制」。复用既有平台身份、租户隔离(RLS)与审计
设施,**新增一张支持访问授权表**(本阶段非零 migration)。本文档为 Phase 1K 的完整
规划(§1–§8),经用户确认后再按节实施;体量较大,可按 §1.4 拆 1K-A(租户生命周期 +
闸门)/ 1K-B(支持访问授权)分批落地。

## 1. 目标与范围

### 1.1 背景与目标

KirinDesk 的对外承诺把信任放在第一位(CLAUDE.md §3):「客户数据属于客户」「平台
管理员不得默认无限访问租户业务数据」「未来的支持访问必须要求客户授权、原因、范围、
时限和审计日志」。盘点现状,有两处**信任核心至今为零**:

- **平台支持访问 = 完全没有通道**:平台管理员经 `/api/platform-auth` 以
  `platform_admin` 身份(`tenantId: null`)登录,登录写入 `platform` 审计链;但
  **没有任何租户业务端点接受平台身份**(全仓 `PlatformAuthGuard` 仅用于
  platform-auth 自身),且 RLS 一律按 `app_current_tenant_id()` 收口、对 `app`
  角色无平台旁路。也就是说:今天平台管理员**既无法**访问任何租户业务数据(这点
  与「无默认访问」一致,是好事),**也没有**一条「客户授权后、受控、受审计、限时」
  的支持访问路径——当客户真的需要平台协助排障时,只能靠数据库直连等不可治理、
  不可审计的手段。§3 点名要做的那条「受治理支持访问」**根本不存在**。
- **租户生命周期 = 有状态列、无人执行**:`tenants.status`(默认 `active`,已建
  索引)存在,但**没有任何中间件/守卫据其拦截**——一个被「停用」的租户,其用户
  照样能登录、照常读写业务数据。这正是 Phase 1E 当初挂起的「下载前的租户状态
  闸门……应在全局租户生命周期中间件里做,而非文件模块」那笔欠债,至今未还。

本阶段目标:补上这两件信任核心,且让它们**与刚建好的审计查看/导出(1I/1J)形成
闭环**——

1. **受治理的平台支持访问**:由**有权的租户用户授权**(客户授权是基石,平台管理员
   **不能**自行授予自己访问租户业务数据的权限),授权携带**原因 + 范围 + 时限**;
   平台管理员仅在**存在有效授权**时,才能在该范围/时限内访问对应租户数据,**默认
   拒绝**;授权的创建/激活/到期/撤销,以及**每一次基于授权的访问**,全部写入审计
   且**对租户可见**(经 1I 审计查看器)。平台管理员的身份在审计中**始终保留为
   `platform_admin`**,绝不伪装成租户用户(非「冒名顶替」)。
2. **租户生命周期闸门**:平台管理员可查看/变更租户 `status`(如 active ↔
   suspended),且新增**全局强制**——非 active 租户的租户用户访问被统一拦截
   (落实 1E 欠债);每次状态变更审计留痕。

### 1.2 本阶段要做(范围内)

- **租户生命周期(平台侧)**:
  - 平台管理员**只读**租户清单/单租户元信息(name/slug/status/created 等**非业务**
    字段),用于运营可见性;**不**含任何租户业务数据(客户/订单/金额等)。
  - 平台管理员变更租户 `status`(active ↔ suspended;具体状态集 §3 钉死),每次
    变更带原因、写审计。
  - **全局租户状态闸门**:在租户认证链路上增加统一校验,非 active 租户的租户用户
    请求被拦截(返回明确状态,§4/§5 定);该闸门替代并收口 1E 当初挂起的逐模块
    状态检查。
- **平台支持访问(受治理)**:
  - **支持访问授权模型**(新表,§2):一条授权记录由**有权的租户用户**创建/批准,
    指向一个具名平台管理员(或具名平台请求),携带 `reason`、`scope`(范围语义
    §3 钉死,如「只读」/限定模块)、`expires_at`(时限),状态机覆盖
    授权→生效→到期/撤销(精确状态集与转换 §3)。
  - **平台管理员据有效授权访问租户数据**:平台身份 + 有效授权 → 获得一个**受限、
    限时**的租户上下文,从而能复用既有租户读路径在**授权范围内**取数;无有效授权
    → **默认拒绝**。「平台身份如何安全地取得这个受限租户上下文以复用既有读取」是
    本阶段的核心设计点,在 §3/§4 钉死;贯穿的不变式是:**审计里永远是平台身份**,
    范围/时限由授权强制,越权或过期一律拒绝。
  - **全程审计 + 租户可见**:授权生命周期每次转换、以及每次基于授权的访问,经既有
    `AuditService` 写审计(写哪条链——租户链让客户看见「平台何时访问了我」,
    还是同时写平台链——§4 钉死);这些事件能在 1I 审计查看器里被租户看到,把「谁
    在何时、凭哪条授权、为何访问了我的数据」呈现给客户。
- **RBAC**:租户侧「授权支持访问」「撤销支持访问」是敏感操作,须有相应权限码
  (新增于 system 模块,§2/§3 定),默认仅租户 owner/管理员可授权;平台侧操作由
  平台身份 + 平台侧校验把关(平台管理员之间是否再分级,§3 评估)。

### 1.3 本阶段不做(范围外)

- **不做平台侧「自由浏览租户业务数据」的控制台**:平台对租户数据的访问**只有**
  「客户授权 + 受限 + 限时 + 审计」这一条路径,**不**提供无授权的跨租户业务数据
  浏览/检索/分析界面。无默认访问是红线(§4)。
- **不做「冒名顶替」(impersonation)登录为某个租户用户**:支持访问是平台管理员
  以**自己的平台身份**在授权范围内操作,审计中始终是 `platform_admin`,不伪装成
  租户用户、不签发租户用户 token。
- **不做租户自助注册/开通/计费/套餐升级**:`plans` 等 seed 虽在,计费与自助开通
  是独立方向,不在本阶段;本阶段租户生命周期只覆盖**运营侧的 status 启停**。
- **不做硬删除/数据清除/GDPR 擦除/数据导出给平台**:租户停用只改 `status` + 闸门
  拦截,**不**删数据;平台侧不导出租户业务数据(导出仍是租户自助,见 1J)。
- **不做客户授权的站外通知/邮件**(「平台请求访问,请批准」之类的外发):通知是
  provider 抽象方向(§7 mock-first),本阶段授权在产品内完成,不外发。
- **不做后台自动到期清扫任务**:授权按 `expires_at` 在**使用时校验**即过期失效;
  独立的定时清扫/状态回填作为后续优化,本阶段不引(§风险与回滚记边界)。
- **不改既有审计写入路径/哈希链/append-only 约束**:本阶段只**新增**被审计的
  action 类型(支持访问/租户生命周期),不动 `AuditService`、哈希算法、链结构、
  022/023 触发器。

### 1.4 与既有平台身份 / 租户隔离 / 审计设施的关系

本阶段严格复用、绝不削弱既有边界:

- **平台身份(复用)**:沿用 `platform_admins` + `/api/platform-auth` 的
  `platform-jwt`(`type=platform_admin`、`tenantId: null`);本阶段在其之上加
  「租户生命周期管理」与「支持访问」端点,不改既有登录/审计。
- **租户隔离 / RLS(复用且不放大)**:支持访问取得的受限租户上下文,**走与租户
  用户相同的 `withTenantContext` + RLS 路径**——平台身份并不绕过 RLS,而是被授权
  后获得一个明确的、限时的 `tenant_id` 上下文,因此天然只见被授权租户、且只在
  授权范围内;无授权时不设任何租户上下文,默认拒绝。这是「复用隔离」而非「开后门」。
- **审计设施(复用,且这是本阶段的收口)**:支持访问与租户生命周期都是 §6 明列的
  敏感操作,经既有 `AuditService` 入既有链(`platform` / `tenant:<id>`),并经 1I
  审计查看器对租户可见——「看审计的人也该被审计」「平台动了我的数据要留痕」在此
  闭环。审计写入路径、哈希、append-only 一律不动。
- **租户状态列(复用)**:`tenants.status` 已存在,本阶段补「平台可变更」+「全局
  闸门强制」,不改其结构。
- **净增**:相对 1I/1J 的零 migration,本阶段**预计新增一张支持访问授权表**
  (+ 可能的索引/RLS),并在**租户认证链路加一道状态闸门**——属跨身份边界的治理
  改动,体量与风险高于 1I/1J,故 §2(迁移)、§3/§4(平台取得受限租户上下文的
  机制、状态机、护栏)需逐项钉死后再实施;必要时按子阶段(如 1K-A 租户生命周期 +
  闸门、1K-B 支持访问授权)拆分推进,拆分与否在 §3 评估后定。

## 2. 数据模型与迁移

与 1I/1J 的零 migration 不同,本阶段**有一支迁移**(预计 `036`):新增一张支持
访问授权表 + 其 RLS / 校验函数 / 冻结触发器,给 `tenants.status` 加状态 CHECK,
并**新增一条 `audit_logs` INSERT policy** 让平台访问事件能落入**租户自己的**哈希链
(从而对租户可见)。哈希算法、链结构、append-only 约束(022/023)与 `AuditService`
**一律不动**。新增 RBAC 码走 seed(非 migration)。

### 2.1 既有可复用(不改)

- **平台身份**:`platform_admins` 表 + `/api/platform-auth`(`platform-jwt`,
  `type=platform_admin`、`tenantId: null`)。本阶段在其上加租户生命周期与支持访问
  端点,不改登录/既有审计。
- **租户状态列**:`tenants.status`(默认 `active`)+ `idx_tenants_status` 已存在
  (003);本阶段只**补 CHECK + 补「平台可改」+ 补全局闸门**,不改结构。
- **RLS 设施**:`app_current_tenant_id()` / `app_current_user_id()` /
  `app_current_actor_type()`(002)+ 各表 FORCE RLS + `withTenantContext`。支持
  访问取得的受限租户上下文走同一套,不绕 RLS。
- **审计**:`audit_logs` + `audit_log_chains` + `AuditService.writeToChain` +
  1I 审计查看器。支持访问/生命周期事件经其写入、对租户可见;不新增审计表。

### 2.2 新表 `support_access_grants`(migration 036)

一条记录 = 「某租户的有权用户,授权某具名平台管理员,在某范围/时限内访问本租户
数据」的客户授权凭证。

| 列 | 类型 | 用途 |
|---|---|---|
| `id` | uuid PK | 授权 id;前端/审计引用。 |
| `tenant_id` | uuid NOT NULL REFERENCES tenants(id) | **被访问**的租户;RLS 隔离依据。 |
| `platform_admin_id` | uuid NOT NULL REFERENCES platform_admins(id) | 被授权的**具名**平台管理员(最小授权:授权指向具体人,而非「任意平台管理员」)。 |
| `granted_by_user_id` | uuid NOT NULL REFERENCES users(id) | **客户授权人**——发起/批准授权的租户用户(§3 的 RBAC 把关);授权基石(§1.1)。 |
| `reason` | text NOT NULL | 授权原因(必填,§3/§6)。 |
| `scope` | varchar(32) NOT NULL | 范围语义;本阶段先 `read_only`(具体集合 + 是否限模块在 §3 钉死),CHECK 约束取值。 |
| `status` | varchar(20) NOT NULL DEFAULT 'active' | 存储态:`active` / `revoked`;CHECK 约束。**`expired` 不入库**(见下「有效性」)。 |
| `expires_at` | timestamptz NOT NULL | 时限(必填);有效性在**使用时**据此判定,不靠后台清扫(§1.3)。 |
| `revoked_by_user_id` | uuid REFERENCES users(id) | 撤销人(可空,仅 revoke 时写)。 |
| `revoked_at` | timestamptz | 撤销时间(可空)。 |
| `created_at` | timestamptz NOT NULL DEFAULT now() | 授权时间。 |

- **有效性(派生,非状态机额外态)**:一条授权「当前有效」⇔
  `status='active' AND revoked_at IS NULL AND expires_at > now()`。过期是**派生**
  的(到点即失效),无需 `expired` 落库、也无需定时任务——平台每次访问/校验时
  现算(同 1J「不引后台清扫,使用时校验」)。状态机精确转换在 §3。
- **约束**:`CHECK (status IN ('active','revoked'))`、`CHECK (scope IN
  ('read_only'))`(§3 可扩);`expires_at` NOT NULL。
- **是否含「平台先申请、租户后批准」的请求流**(会让 `granted_by_user_id` 在批准前
  可空 + 增加 `requested`/`denied` 态):留 §3 状态机定。**默认采「租户主动授权、
  创建即 active」最简模型**,上表按此(`granted_by_user_id` NOT NULL);若 §3 采纳
  请求流,再放宽该列并扩 status CHECK。

### 2.3 索引

- `idx_support_grants_tenant (tenant_id, created_at DESC)` → 租户侧列表(本租户
  授权历史,RLS 下走此)。
- `idx_support_grants_admin_active (platform_admin_id, tenant_id) WHERE status =
  'active'` → 平台侧校验「(此管理员, 此租户)是否有 active 授权」的热路径
  (配合 §2.4 的 SECURITY DEFINER 校验函数);部分索引只覆盖 active 行。

### 2.4 ⚠️ 隔离细节(必须显式处理):双向可见 + 平台侧校验

`support_access_grants` 同时被**租户用户**(读写本租户的授权)与**平台管理员**
(跨租户、但只该看「指名自己」的授权)访问。单一
`tenant_id = app_current_tenant_id()` 策略(如 order_approvals)只解决租户侧,会把
平台侧(无租户上下文)挡死。仿 `audit_logs` 的「多策略 + 角色判定」与 1E 的
SECURITY DEFINER 思路:

- **租户侧 RLS**:`FORCE RLS` + policy
  `tenant_id = app_current_tenant_id()`,覆盖租户用户的创建(INSERT)、列表
  (SELECT)、撤销(UPDATE)。默认特权授予会给 `kirindesk_app` 全套 DML;本表**保留
  UPDATE**(撤销是改 `status`/`revoked_*`),但用**冻结触发器**(下条)把授权条款
  锁死。
- **冻结触发器(防授权条款被篡改)**:`BEFORE UPDATE` 仅允许
  `status` / `revoked_by_user_id` / `revoked_at` 变更,其余列(`reason` / `scope` /
  `expires_at` / `platform_admin_id` / `tenant_id` / `granted_by_user_id`)一经创建
  **不可改**——客户授权的「为何/多大范围/到何时」不能事后被悄悄放大(仿
  commission_payout 的冻结金额列触发器)。
- **平台侧校验(SECURITY DEFINER,窄查询)**:平台管理员持 `platform-jwt`、无租户
  上下文,RLS 读不到任何行。新增 SECURITY DEFINER 函数(仿 `app_lookup_file_token`,
  `GRANT EXECUTE ... TO kirindesk_app`),由服务端**传入已认证的
  `platform_admin_id`**(绝不接受任意 id)调用:
  - `app_lookup_support_grant(p_admin_id, p_tenant_id)` → 返回该对是否存在 active
    且未过期的授权及其 `scope`/`expires_at`;平台访问前据此校验,**有效才**设租户
    上下文取数,否则默认拒绝。
  - `app_list_support_grants_for_admin(p_admin_id)` → 返回**指名该管理员**的授权
    列表(平台侧「哪些租户授权了我」视图)。
  二者都只按「调用方=已认证平台管理员本人」取数,**无有效配对则一无所获**,不泄漏
  他人/他租户授权的存在性。
- 这样:平台身份**不绕 RLS**——它先经 SECURITY DEFINER 窄校验确认授权,再获得一个
  明确、限时的 `tenant_id` 上下文,之后所有业务读仍走既有 RLS,天然只见被授权租户、
  且范围由 `scope` 在服务层强制(§3/§4)。

### 2.5 审计写入:平台访问事件落入「租户链」(新增一条 INSERT policy)

目标是「平台访问对**租户**可见」。但既有 `audit_logs` INSERT 策略(021)里:
`audit_logs_platform_insert` 要求 `tenant_id IS NULL`、`audit_logs_tenant_insert`
要求 `actor_type='tenant_user'`——**平台管理员无法写入带 `tenant_id` 的审计行**,
于是平台事件只能进 `platform` 链,而租户用户(1I 查看器,actor=tenant_user)**看
不到** NULL-tenant 行。为让「平台何时访问了我」进入**租户自己的、可在 1I 看到的、
被哈希链保护的**审计,迁移 036 **新增**一条 INSERT policy:

```
audit_logs_platform_tenant_insert:
  actor_type = 'platform_admin' AND tenant_id = app_current_tenant_id()
```

- 配合 §2.4 的「校验后设租户上下文(tenant_id = 被授权租户, actor_type =
  platform_admin)」,平台的 `support_access.accessed` 等事件即写入
  `tenant:<id>` 链(`AuditService` 据非空 tenantId 选链),**actor 仍是
  `platform_admin`**(绝不伪装租户用户),且租户能在 1I 查看器看到。
- **不削弱不可篡改**:这是**新增一条 INSERT 策略**,`audit_logs` 的
  REVOKE UPDATE/DELETE(023)、拒改触发器(022)、哈希算法/链结构一律不动;
  `verifyChain` 对混入的 platform_admin 行照常逐行重算(actor_type 本就是哈希输入
  的一部分)。DOWN 删除该 policy 即净回退。
- **租户侧的授权/撤销事件**(`support_access.granted` / `.revoked`)由租户用户发起,
  走既有 `audit_logs_tenant_insert`,无需新策略。具体 action 命名 / 各落哪条链在
  §4 钉死;§2 只负责「平台事件能进租户链」这一**结构前提**。

### 2.6 `tenants.status` 加状态 CHECK

`tenants` 现仅有 `status` 默认 `active`、无取值约束。迁移 036 补
`CHECK (status IN ('active','suspended'))`(显式、可调试的状态边界,CLAUDE.md §5)。
**纯加法且安全**:现有行皆 `active`(dev/test 种子),无回填;DOWN 删约束。状态
变更**历史**落审计(`tenant.suspended` / `.activated`),**不**新增列/历史表。

### 2.7 RBAC 码(seed,非 migration)

支持访问的**租户侧**敏感动作需新权限码(system 模块,id …007),走
`db/seeds/002_permissions.sql`(+ 测试 `fixtures` 补授,同 1J 做法),**不引
migration**:

- `support_access:grant`(授权平台访问)、`support_access:revoke`(撤销)、
  `support_access:view`(查看本租户的授权记录)。默认仅租户 owner / 管理员持有。
- **平台侧**(租户生命周期、平台读授权)由**平台身份 + 平台侧校验**把关,不挂租户
  RBAC;平台管理员之间是否再分级(如「可停用租户」独立于「可支持访问」)留 §3
  评估,默认不细分。

### 2.8 不需要的变更

- **无新审计表**;不改 `AuditService` / 哈希算法 / `hash_version` / 链结构 /
  append-only 的 REVOKE 与触发器(022/023)——本阶段对 `audit_logs` 只**加一条
  INSERT policy**(§2.5)。
- **无业务数据表结构变更**:租户停用只改 `status` + 闸门拦截,不删/不动业务表。
- **不为租户用户签发任何平台 token、不签发租户用户 token 给平台**(非冒名,§1.3);
  无 impersonation 所需的会话/令牌模型。
- 迁移仅 `036`(一张表 + 其 RLS/函数/触发器、一条 audit_logs policy、一个 tenants
  CHECK);可逆 UP/DOWN,DOWN 为净移除(详于 §7 回滚)。

## 3. 后端 API 端点(端点 + 状态机 + 受限租户上下文)

本阶段后端分**三个端点面**,共用既有守卫/服务,只新增一个 `SupportAccessGuard`;
另加一道**全局租户状态闸门**(跨切面,非端点)。所有写与敏感读经既有 `AuditService`
留痕(命名/落链在 §4)。本节把状态机、受限租户上下文机制、scope 语义一并钉死。

### 3.1 端点总览

**租户侧:支持访问授权**(`@Controller('api/support-access')`,`TenantAuthGuard +
PermissionGuard`):

| 方法 & 路由 | 权限 | 说明 |
|---|---|---|
| `POST /api/support-access` | `support_access:grant` | 创建一条 `active` 授权(platformAdminEmail→id、reason、scope、expiresAt);审计 `support_access.granted`。 |
| `GET /api/support-access` | `support_access:view` | 本租户授权列表(active + 历史);RLS 限本租户。 |
| `GET /api/support-access/:id` | `support_access:view` | 单条授权详情。 |
| `POST /api/support-access/:id/revoke` | `support_access:revoke` | 撤销(reason 必填);审计 `support_access.revoked`。 |

**平台侧:租户生命周期**(`@Controller('api/platform/tenants')`,`PlatformAuthGuard`):

| 方法 & 路由 | 守卫 | 说明 |
|---|---|---|
| `GET /api/platform/tenants` | 平台身份 | 租户清单(id/name/slug/status/created,**无业务数据**);分页 + status 过滤。 |
| `GET /api/platform/tenants/:id` | 平台身份 | 单租户**元信息**。 |
| `PATCH /api/platform/tenants/:id/status` | 平台身份 | 启停(active↔suspended,reason 必填);审计 `tenant.suspended` / `.activated`。 |

**平台侧:受授权的只读支持访问**(`PlatformAuthGuard` + 对 `:tenantId` 读加
`SupportAccessGuard`):

| 方法 & 路由 | 守卫 | 说明 |
|---|---|---|
| `GET /api/platform/support-grants` | 平台身份 | 「哪些租户授权了我」——经 `app_list_support_grants_for_admin(本人 id)`(§2.4)。 |
| `GET /api/platform/tenants/:tenantId/audit-logs` (+ `/:id`, `/chain/verify`) | 平台身份 + 有效授权 | 只读被授权租户审计(复用 `AuditQueryService`);每次审计 `support_access.accessed`。 |
| `GET /api/platform/tenants/:tenantId/users` , `/roles` | 平台身份 + 有效授权 | 只读被授权租户的用户/角色**配置**(复用 1H 读路径)。 |

### 3.2 状态与生命周期(状态机)

- **授权(support_access_grants)**:`∅ --grant(租户)--> active --revoke(租户)-->
  revoked`;`active` 在 `expires_at` 到点后**派生失效**(不落 `expired`、不需后台
  清扫,§2.2)。**不含** `requested`/`denied`——本阶段采**租户主动授权**,不做
  「平台申请→租户批准」的请求流(更简;请求流作为后续会引入 `requested`/`denied`
  态 + `granted_by` 可空,§2.2 已记)。
- **租户(tenants.status)**:`active <--> suspended`(平台 suspend/activate);其余
  取值由 §2.6 的 CHECK 拒绝。
- 两个状态机的每次转换都**要 reason 且写审计**;**非法转换**(撤销已撤销、停用已
  停用、激活已激活等)→ **409**。

### 3.3 租户侧:支持访问授权端点

- **POST**:DTO `{ platformAdminEmail @IsEmail, reason @IsString(非空), scope
  @IsIn(['read_only']), expiresAt @IsISO8601(且 > now()) }`。服务端把 email 解析为
  `platform_admin_id`(未知/停用管理员 → 统一 404,不泄漏存在性);插入 `active` 行
  (`granted_by = 调用者`)。同 (admin, tenant) 已有未过期 active 授权 → 幂等返回 /
  409(§4 定)。
- **GET 列表/详情**:RLS 限本租户;dataScope —— 授权管理属租户管理职能,要求
  **all-scope**(own 对授权无意义,授权不绑资源 owner),§4 钉死。
- **revoke**:仅能撤销**本租户**的 active 授权;已 revoked/expired → 409 / 幂等;
  冻结触发器(§2.4)保证只动 `status`/`revoked_*`,授权条款不可被改。

### 3.4 平台侧:租户生命周期端点

- **列表/详情**只回**元信息**,绝不回业务数据(§1.3)。
- **PATCH status**:reason 必填;`active→suspended` / `suspended→active`;同态重复
  → 409。审计 `tenant.suspended` / `.activated` 写入**该租户链**(经 §2.5 policy,
  actor=`platform_admin`),使租户(复用后)能在 1I 看到。平台管理员之间是否需
  「可启停」子权限,§4 评估,默认不细分。

### 3.5 平台侧:受授权只读访问(核心机制,钉死)

- **`SupportAccessGuard`**(在 `PlatformAuthGuard` 之后执行):取路由 `:tenantId` +
  JWT 平台管理员 id → 调 `app_lookup_support_grant(adminId, tenantId)`(§2.4 的
  SECURITY DEFINER 窄校验)→ **无 active 且未过期授权 → 403**(默认拒绝);有则把
  `scope` 暂存到 request 后放行。
- 控制器随后以 `withTenantContext({ tenantId, userId: adminId, actorType:
  'platform_admin' })` 打开**受限租户上下文**,复用既有**只读服务**
  (`AuditQueryService.list/getOne/verifyTenantChain`、1H 的 users/roles 读)取数——
  业务读仍走 RLS,天然只见被授权租户;dataScope 取 `all`(支持需全租户视图,但
  只读)。
- 每次成功访问写 **`support_access.accessed`**(actor=`platform_admin`、
  `tenant_id`=被授权租户、metadata 记 grantId/scope/所访问资源类型),经 §2.5 policy
  入**租户链** → 对租户可见(与 1I/1J 闭环)。
- **`scope=read_only` 由「不存在任何平台→租户写端点」从结构上保证**:本阶段平台侧
  只挂 `GET`,无任何写/改租户数据的路由——read_only 是「没有别的路可走」,而非仅靠
  标志位。未来若需写能力,须**显式新增**写端点 + 扩 scope 取值。
- **设计抉择(钉死)**:用平台命名空间下的**专用只读端点**
  (`api/platform/tenants/:tenantId/...`),而非「让既有租户端点也接受平台身份」——
  后者要改 `TenantAuthGuard` 的主体类型,牵动面大、易错;专用端点让平台路径**显式、
  可独立审计、租户认证层零改动**,代价是复用服务层(非控制器),可接受。

### 3.6 全局租户状态闸门

- 在租户认证链路上(`TenantAuthGuard` 之后,或一个全局 guard)加统一校验:解析出
  caller 的 `tenantId` → 查 `tenants.status` → 非 `active` → **统一拦截**(403 +
  明确文案「租户已停用」;登录端点也在认证后拒发 token)。**一处实现**,替代并收口
  1E 当初设想的逐模块状态检查。
- 平台侧端点不受此闸门约束(平台身份不绑租户 status)。被 suspend 的租户**是否仍
  允许平台只读支持访问**——§4 定,倾向**允许**(排障常发生在停用之后)。
- 闸门只读 `tenants.status` 不改;实现形态(全局 guard vs 中间件、是否缓存)
  在 §4/§5 定。

### 3.7 dataScope / 隔离小结

- **租户侧授权端点**:RLS 限本租户 + `support_access:*` 权限;dataScope `all`。
- **平台侧**:无授权 → 一无所获(SECURITY DEFINER 校验 + 默认拒绝);有授权 →
  仅该租户、只读、限时、**每次访问留痕**。
- **跨租户**:租户 A 用户永远看不到租户 B 的授权(RLS);平台管理员只看**指名自己**
  的授权(SECURITY DEFINER 按本人 id 取数,§2.4)。

### 3.8 不做的端点

- 无平台侧租户**业务数据**(客户/订单/金额/提成)只读端点——本阶段平台只读限于
  **审计 + 用户/角色配置**;业务数据的受授权只读作为后续**审慎扩面**(往 §3.5 的
  白名单**显式加端点**,而非默认开放)。
- 无任何平台→租户**写**端点(scope 仅 `read_only`)。
- 无 impersonation / 代登录端点。
- 无「平台申请→租户批准」请求流端点(本阶段租户主动授权)。
- 无租户硬删除 / 数据清除 / 导出给平台的端点。
- 无后台到期清扫端点(到期使用时校验)。

## 4. 安全护栏与审计

本阶段跨越平台/租户身份边界,是迄今最敏感的一块,护栏重心是:**客户授权是唯一
入口、默认拒绝、平台永不冒名、授权条款不可篡改、跨租户不可越权、且全程对租户可见
留痕**。所有判定**服务端强制**(CLAUDE.md §4)。本节同时钉死 §1–§3 推来的待定项:
落哪条链、action 命名与 metadata、重复授权处置、停用租户下平台只读是否放行、平台
是否细分子权限、闸门形态。

### 4.1 护栏(服务端强制)

1. **客户授权是唯一入口 + 默认拒绝(核心)**:平台**不能自授**对租户业务数据的
   访问;每次平台只读都要求一条**租户授权、active、未过期、且指名本管理员**的
   grant,`SupportAccessGuard` 经 §2.4 的 SECURITY DEFINER 校验,**无有效授权一律
   403**——无 grant 则不设任何租户上下文,什么都取不到。
2. **平台永不冒名(核心)**:平台一切动作在审计里 `actor_type='platform_admin'`、
   `actor_id=平台管理员 id`;**不签发租户用户 token、不冒充租户用户**;租户在 1I
   里看到的永远是「平台管理员(非本租户用户)」——`actorName` 经 users 联表**解析
   不到**(平台管理员不在 users 表),回退显示 actorId + `platform_admin` 标签,
   这正是「可辨认是平台在访问」的预期。
3. **授权条款不可篡改**:§2.4 的冻结触发器锁死 `reason`/`scope`/`expires_at`/
   `platform_admin_id`/`tenant_id`/`granted_by`——授权后不能被**悄悄放大范围或延长
   时限**;要改条款只能撤销后重新授权(留两条审计)。
4. **最小授权 + 限时 + 范围(结构性)**:grant **指名具体管理员**(非「任意平台
   管理员」);`expires_at` 必填且在**使用时**判定过期(派生失效);
   `scope=read_only` 由「平台侧不存在任何写端点」**从结构上**保证(§3.5),非仅
   标志位。
5. **跨租户不可越权**:SECURITY DEFINER 校验函数只接受**服务端传入的、JWT 已认证的
   管理员 id**(绝不取客户端传参);平台只看**指名自己**的授权;读租户 T 必须持
   **针对 T** 的 grant(逐请求按路由 `:tenantId` 校验);租户 A 用户经 RLS 永远看
   不到租户 B 的授权。
6. **租户隔离不被放大**:平台只读走**与租户用户相同的** `withTenantContext` + RLS,
   平台身份**不绕 RLS**,而是被授权后获得一个明确、限时的 `tenant_id`,因此天然只
   见被授权租户;dataScope 取 `all`(支持需全租户只读视图),但**仅限该租户**。
7. **租户状态闸门 fail-closed**:非 `active` 租户的**租户用户**请求统一 403(含
   登录后拒发 token),一处全局强制(§3.6)。**停用租户下平台只读支持访问仍放行**
   (钉死)——排障常发生在停用之后,且该访问本身受「active grant + 审计」约束,
   是受控的;平台侧端点不受租户状态闸门约束。
8. **RBAC 服务端强制 + 平台不细分(钉死)**:租户侧 `support_access:grant/revoke/
   view` 由 `@RequirePermission` + PermissionGuard 判定(默认仅 owner/管理员持有);
   **平台侧**租户生命周期与受授权只读由**平台身份 + 平台校验**把关,本阶段**不**在
   平台管理员之间细分子权限(平台管理员是小而可信的集合,且**每个动作都审计**;
   子角色留后续)。
9. **重复授权 → 409(钉死)**:同 (admin, tenant) 已有 active 未过期 grant 时,
   再次授权返回 **409**(而非幂等静默)——因条款被冻结,改条款须先撤销;409 文案
   引导「先撤销现有授权」。非法状态转换(撤销已撤销、停用已停用…)同样 409。
10. **输入校验 + 防注入**:DTO whitelist + forbidNonWhitelisted;`platformAdminEmail`
    `@IsEmail`(服务端解析为 id,未知/停用 → **统一 404**,不泄漏平台管理员存在性);
    `expiresAt` 必须为将来;`scope` `@IsIn(['read_only'])`;所有查询参数化下推。
11. **不可篡改不被削弱**:对 `audit_logs` **仅新增一条 INSERT policy**(§2.5);
    REVOKE UPDATE/DELETE(023)+ 拒改触发器(022)+ 哈希算法/链结构一律不动;
    平台事件混入租户链后 `verifyChain` 照常 PASS。

### 4.2 审计(敏感操作必留痕,落链与形状钉死)

与 1I/1J 一致:普通读不审计,但**跨边界的平台只读是敏感访问 → 必审计**(同 1J 导出
的取舍)。全部经既有 `AuditService` 入既有链,**写哪条、记什么**:

| action | actor_type | 落链 | resource_type / id | metadata(标识 + 摘要,无业务明文) |
|---|---|---|---|---|
| `support_access.granted` | tenant_user | **租户链** | support_access_grant / grantId | `{ platformAdminId, scope, expiresAt, reason }` |
| `support_access.revoked` | tenant_user | **租户链** | support_access_grant / grantId | `{ platformAdminId, reason }` |
| `support_access.accessed` | platform_admin | **租户链**(经 §2.5 policy) | support_access_grant / grantId | `{ scope, resourceType, route }` |
| `tenant.suspended` / `tenant.activated` | platform_admin | **租户链** | tenant / tenantId | `{ reason }` |

- **一律落租户链**:让客户在 1I 审计查看器看到「谁(平台管理员)在何时、凭哪条授权
  (grantId)、为何(reason)、访问/改动了什么」——这是本阶段的核心信任价值点。
- **reason 入审计是刻意的**:它是客户授权/平台启停的**目的说明**(治理证据),非
  业务明文;`metadata` 只记标识 + 授权条款 + 访问的资源类型,**绝不**记被读到的
  逐行业务数据。
- **`.accessed` 的噪声(已知)**:本阶段**每次访问请求记一条**(翻页多次读=多条);
  按会话/时间窗聚合去噪作为后续优化(同 1I 对 `audit.viewed` 的取舍),先求**不
  漏记**。
- **不改写入路径**:`AuditService`、哈希、`hash_version`、链结构、append-only 约束
  一律不动(§2.5/§2.8)。

### 4.3 验证这些护栏(集成/单元测试覆盖,详列 §6)

- **默认拒绝**:平台无 grant 读租户数据 → 403;**过期** grant → 403;**已撤销** →
  403;**active 有效** → 200 且写一条 `support_access.accessed`。
- **跨租户**:针对 T1 的 grant 不能读 T2;平台 `support-grants` 列表只含指名自己的;
  租户用户看不到他租户授权。
- **不可篡改**:对 grant 的 `reason`/`scope`/`expires_at` 做 UPDATE → 冻结触发器
  拒绝(仅 status/revoked_* 可改)。
- **不冒名**:`.granted`/`.accessed`/`tenant.suspended` 事件 `actor_type=
  platform_admin`(或 tenant_user for granted);全程无租户用户 token 签发。
- **租户闸门**:suspended 租户的用户请求(含登录) → 403;active → 放行;且
  suspended 租户下平台持有效 grant 仍可只读。
- **RBAC**:无 `support_access:grant` 的租户用户 POST 授权 → 403(并命中既有
  `rbac:permission_denied` 留痕);无 token → 401。
- **审计→租户链 + 链完整**:平台访问后,**租户**在 1I 能看到该 `support_access.
  accessed`;`verifyChain(tenant:<id>)` 仍 PASS。
- **409 / 校验**:重复 active 授权 → 409;非法状态转换 → 409;未知
  platformAdminEmail → 404;过去时间 `expiresAt` → 400。

## 5. 前端页面与导航

本阶段前端横跨**两个身份面**,故有两块界面:① **租户侧**(既有 web app,
tenant-jwt)——客户授权/撤销/查看支持访问的管理页,这是「客户授权」基石的落点,
且与 1I 审计查看器闭环;② **平台侧**(platform-jwt)——平台控制台:租户生命周期 +
「哪些租户授权了我」+ 受授权只读视图。两块都复用既有 `request<T>()` / `ApiError`
按 status 映射 / 行内 `CSSProperties` 中文 / 服务端 403 优雅降级约定,无新依赖。

> **体量提示**:租户侧管理页落在既有 app、小而低风险,是本阶段前端**主交付**;
> 平台控制台需引入**第二套鉴权**(platform-jwt 独立 token + 独立路由树/布局),是
> 更重的一半——若按 §1.4 拆分,平台控制台即 **1K-B 前端**。本节把两者都规格化,
> 实施时可分批落地。

### 5.1 租户侧:支持访问管理页(主交付,cornerstone)

`apps/web/src/support-access/SupportAccessPage.tsx`(路由 `/support-access`),供
租户 owner/管理员:

- **授权列表**:表格列 = 平台管理员(邮箱/标识)、范围(read_only)、**有效状态**、
  授权人、到期时间、创建时间、操作。**有效状态在前端按 `expires_at` 派生**——后端
  存储态只有 active/revoked(§2.2),页面对 active 且 `expires_at < now()` 的行显示
  「已过期」(灰),active 未过期显示「生效中」(绿),revoked 显示「已撤销」。
- **新建授权**(草稿态表单 → 提交):平台管理员邮箱、原因(必填)、范围(read_only)、
  到期时间(`<input type="datetime-local">` 或日期,默认给一个短时窗如 24h);提交
  调 `POST /api/support-access`;未知邮箱 → 404 文案、重复 active → 409 文案、过去
  时间 → 400 文案,均内联不崩页。
- **撤销**:仅「生效中」行可撤销,点击 → 填撤销原因 → `POST /:id/revoke`;撤销后
  行变「已撤销」。
- **整页 403 降级**:无 `support_access:view` → 整页「没有权限管理支持访问」(同
  reports/audit 页约定)。
- **隐私**:授权内容只在 React state;不写 localStorage/sessionStorage/URL/console
  (§浏览器 QA spot-check)。

### 5.2 租户侧:平台访问的可见性(复用 1I,无新页面)

支持访问/生命周期事件都落**租户链**(§4.2),因此租户在既有 **1I 审计查看器**
(`/audit-logs`)即可看到 `support_access.granted/.revoked/.accessed`、
`tenant.suspended/.activated`——**无需新页面**。支持访问管理页顶部给一个跳转链接
(到 `/audit-logs?action=support_access.accessed` 之类的预过滤),把「平台何时访问
了我」直接引到审计页。这正是 1I/1J/1K 的信任闭环:授权在此页发生、访问在审计页
可查。

### 5.3 平台侧:平台控制台(第二套鉴权,较重一半)

平台管理员经 `/api/platform-auth` 登录(platform-jwt,**无 tenantSlug**),既有 web
app **尚无**平台界面,故新增一个**与租户 app 隔离**的最小控制台:

- **登录 + 鉴权**:`/platform/login`(邮箱 + 密码,无租户)→ platform-jwt 存于**独立**
  键(如 `kd_platform_token`,与租户 `kd_access_token` 分开)→ `PlatformAuthContext`
  + `PlatformProtectedRoute` + 极简 `PlatformLayout`(导航:租户 / 我的授权)。**刻意
  与租户 app 的 AuthContext/路由树分离**,避免两套身份混淆(§4 不冒名)。
- **租户生命周期页** `PlatformTenantsPage`(`/platform/tenants`):租户清单
  (name/slug/status/created,**无业务数据**)+ 状态切换(停用/启用,需填原因)→
  `PATCH /api/platform/tenants/:id/status`;同态重复 → 409 文案。
- **我的授权页** `PlatformGrantsPage`(`/platform/support-grants`):「哪些租户授权了
  我」——列出指名本人的有效授权(租户、范围、到期);点击进入受授权租户的只读视图。
- **受授权只读视图** `PlatformTenantViewPage`(`/platform/tenants/:tenantId`):**只读**
  呈现被授权租户的审计 / 用户 / 角色(复用既有列表渲染,数据走平台端点 §3.1);页顶
  **醒目横幅**「你正以平台支持访问身份**只读**查看租户 X(范围 read_only,到期
  …);此访问已被记录并对该租户可见」;**无任何写控件**(scope=read_only,§3.5)。无
  有效授权 / 已过期 → 403 整页提示。

### 5.4 api-client / 类型扩展

- **租户侧**:在既有 `apiClient` 加 `createSupportGrant` / `listSupportGrants` /
  `getSupportGrant` / `revokeSupportGrant`(走既有 `request<T>()`,带租户 token);
  `lib/types` 加 `SupportGrant`(含派生 effective 状态由前端算)、`CreateGrantInput`
  等。
- **平台侧**:新增一个**并行的 `platformRequest<T>()`**(与 `request<T>()` 同构,但
  读/写**独立的 platform token**,401 走平台登出而非租户登出)+ 一组平台方法
  (`platformLogin` / `listTenants` / `getTenant` / `setTenantStatus` /
  `listMyGrants` / `platformTenantAuditLogs` / `…Users` / `…Roles`)。**第二套 token
  与请求路径**是本阶段前端最主要的新增复杂度,需与租户 token 严格隔离(不同存储键、
  不同 401 处理)。
- 受授权只读视图复用 1I 的 `AuditLogSummary/Detail`、1H 的 user/role 类型;只是
  **base 路径**换成 `api/platform/tenants/:tenantId/...`,可把列表渲染抽成参数化
  组件以最大化复用(实施时定)。

### 5.5 导航与路由

- **租户侧**:`App.tsx` 受保护布局下加 `<Route path="/support-access" …/>`;
  `AppLayout` 加导航「支持访问」(always-show + 服务端 403 优雅降级,同 §4 约定;
  `/api/auth/me` 不带权限码、UI 隐藏非边界)。
- **平台侧**:独立路由子树 `/platform/*`(`/platform/login` 公开,其余经
  `PlatformProtectedRoute`),用 `PlatformLayout` 而**不**进 `AppLayout` 导航——两套
  身份的入口、布局、登出彼此独立。

### 5.6 只读 / 隐私 / 降级约定

- **租户页**:无业务数据展示;授权/撤销为仅有的写动作,均带原因、即时反映;403
  整页降级,其他错误内联。
- **平台只读视图**:**零写控件**(read_only);每个视图横幅声明「访问已被记录」;
  只展示**授权范围内**的数据(本阶段=审计 + 用户/角色配置,非业务数据,§3.8)。
- **隐私 spot-check**(浏览器 QA,§6):两面页面源 grep 零 `console.*`、敏感内容不落
  localStorage/sessionStorage/URL(token 存储沿用 app 既有方式,但平台 token 独立键);
  内容刷新即重新拉取。
- **纯加法、无新依赖**:租户页是既有 app 内新增;平台控制台是新文件 + 第二套鉴权,
  但不引第三方库。

## 6. 测试

后端以 **vitest 集成测试**为主(`apps/api/test/platform-access.integration.test.ts`,
supertest 打真实 HTTP,跑在 `kirindesk_test`,复用 `setup-integration` + `fixtures`),
覆盖跨边界授权/默认拒绝/受限上下文/隔离/审计落链;状态机与 `SupportAccessGuard`
走**单元测试**;前端走浏览器 QA(Playwright,两套身份)。提交前置仍是 `pnpm verify`
全绿。本阶段**有迁移(036)**,故还需迁移可逆性校验。

### 6.1 测试前置:fixture / 迁移

- **迁移自动应用**:`setup-integration` 已 `pnpm --filter @kirindesk/database
  migrate` 全量应用,036 随之建表/策略/函数/触发器;无需手动建。**额外校验**迁移
  可逆:`migrate → rollback 036 → migrate` 干净往返(同既有迁移约定,§8)。
- **RBAC 码补授(测试 fixture,非产品 seed)**:在 `fixtures` 的 `SEED_PERMS`(system
  模块)加 `support_access:grant/revoke/view`,授予 admin(scope=all);**sales /
  TEST_USER4 不授**,用于 403。同 1J 做法,不改产品 seed、不引 migration。
- **平台管理员已就绪**:fixture 已 seed `platform_admins`(TEST_ADMIN);测试经
  `/api/platform-auth/login` 取 platform token,据其授权/访问。
- **⚠️ 共享库隔离**:集成测试共用一个串行 DB——**停用 `TEST_TENANT_ID` 会连累所有
  其它测试文件的登录**。故生命周期/闸门用例须用**专用租户**(fixture 新增一个
  `TEST_TENANT3`,仅本文件 suspend),或在单个用例内 suspend→断言→**reactivate
  还原**(`finally` 兜底),严禁让共享库停在 suspended。

### 6.2 集成测试用例(platform-access.integration.test.ts)

**租户侧授权**

- create:admin(`support_access:grant`)`POST /api/support-access`
  `{platformAdminEmail, reason, scope:'read_only', expiresAt:未来}` → 201、status
  `active`、`granted_by=admin`;审计 `support_access.granted` 入**租户链**。
- 未知 `platformAdminEmail` → **404**(不透明);过去 `expiresAt` → **400**;
  scope 非 `read_only` → 400。
- 重复 active(同 admin+tenant 未过期)→ **409**。
- list/get(`support_access:view`):返回本租户授权;RLS 限本租户。
- revoke(`support_access:revoke`):status→`revoked`、写 `revoked_by/at`;审计
  `support_access.revoked`;再撤销 → **409**。
- RBAC:无三码的租户用户 → **403**(并命中既有 `rbac:permission_denied` 留痕);
  无 token → **401**。

**冻结触发器(DB 层,经 admin/superuser 连接)**

- 对一条 grant 直接 `UPDATE reason/scope/expires_at/platform_admin_id` → 触发器
  **拒绝**(报错);仅 `status`/`revoked_*` 可改(仿 022/023 不可变断言的写法)。

**平台侧租户生命周期**

- platform `GET /api/platform/tenants` → 仅元信息(断言**不含**客户/订单等业务字段)。
- `PATCH …/status` active→suspended(reason)→ ok,审计 `tenant.suspended` 入该租户
  链;suspended→active → ok;同态重复 → **409**。**(用专用租户 + 还原)**
- 平台端点须平台 token:租户 token / 无 token → 401/403。

**全局租户状态闸门**

- 专用租户 suspend 后,其用户**登录或任意请求** → **403「租户已停用」**;reactivate
  后恢复。**(finally 还原)**

**平台侧受授权只读访问(核心)**

- **无授权** → platform `GET /api/platform/tenants/:T/audit-logs` → **403**(默认拒)。
- 租户为 (平台管理员, T) 建 active 授权后,platform `GET …/audit-logs` → 200、返回
  **T 的**审计(复用 `AuditQueryService`),并写一条 `support_access.accessed`
  (actor=`platform_admin`、入 **T 的链**);**租户**随后能在自己的审计列表看到它。
- **过期授权 → 403**:因 `expires_at` 创建时必须为未来且冻结触发器禁改,测试**经
  admin 连接直接 INSERT** 一条 `expires_at` 在过去的 grant(INSERT 不被 BEFORE
  UPDATE 触发器拦),再 platform GET → 403。**已撤销 → 403**。
- **跨租户**:针对 T1 的授权不能读 T2(GET T2 → 403);`GET /api/platform/
  support-grants` 只含**指名本管理员**的授权。
- **scope=read_only 结构性**:断言平台侧**不存在**任何写/改租户数据的路由(写尝试
  404/405)。

**审计落租户链 + 链完整**

- granted/revoked/accessed/suspended 后,**以租户身份**查 1I 列表 → 各事件在位、
  `actor_type` 正确(accessed/suspended/activated=platform_admin,granted/revoked=
  tenant_user);`verifyChain(tenant:<T>)` 仍 **PASS**;metadata **无业务明文**。

**SECURITY DEFINER 校验隔离**

- `app_lookup_support_grant` / `app_list_support_grants_for_admin` 只对**传入的
  管理员 id** 返回;管理员 A 拿不到指名 B 的授权(SQL 或服务层断言)。

### 6.3 单元测试(轻量)

- **状态机**:若把转换抽成纯函数(grant:active→revoked 合法、revoked→revoked /
  对已过期再撤销非法;tenant:active↔suspended、同态非法)——断言合法/非法转换。
- **`SupportAccessGuard`**:mock `app_lookup_support_grant` → 有效 grant 放行、
  无/过期/撤销 → 403;并断言它只用**已认证的平台管理员 id**(不取客户端传参)。
- **email→id 解析**:未知/停用管理员 → 统一不透明错误(不泄漏存在性)。

### 6.4 前端浏览器 QA(Playwright + 真实 Chromium,两套身份)

- **租户侧**:登录 admin → `/support-access`:填平台管理员邮箱建授权 → 列表显示
  「生效中」→ 撤销 → 「已撤销」;跳到 `/audit-logs` 见
  `support_access.granted/.revoked`;无 `support_access:view` 用户 → 整页
  「没有权限管理支持访问」。
- **平台侧**:`/platform/login` 以平台管理员登录 → 租户清单 → 停用**专用租户**(填
  原因)再启用 → 「我的授权」显示租户刚建的授权 → 进入受授权租户只读视图:见
  「访问已被记录」横幅、只读审计、**无写控件**;回租户侧确认该访问产生了
  `support_access.accessed`(对租户可见)。
- **隐私 spot-check**:两面页面源 grep 零 `console.*`、敏感内容不落 localStorage/
  sessionStorage/URL;平台 token 存于**独立键**、与租户 token 隔离。
- 截图留证(租户授权/撤销、平台生命周期、受授权只读视图 + 横幅、两类 403)。

### 6.5 质量门槛

- `pnpm verify` 全绿:lint / format / typecheck / build / unit(+ 本阶段状态机/守卫
  单测)/ integration(现有 + platform-access 用例,DB 已含迁移 036)/ security 13。
- **迁移可逆**:`036` up/down/up 干净往返(§8);down 后无悬挂对象(表/策略/函数/
  触发器/CHECK 全净移除)。
- (可选)安全回归脚本追加:`support_access_grants` 冻结触发器拒改授权条款、新
  `audit_logs` INSERT policy 未附带 UPDATE/DELETE——作为「不削弱不可篡改」的静态/DB
  断言。

## 7. 风险与回滚

本阶段是迄今**风险最高**的一支:跨平台/租户身份边界、**有迁移(036)**、新增
SECURITY DEFINER 函数、给 `audit_logs` 加 INSERT 策略、上一道全局租户状态闸门、并
引入第二套前端鉴权。风险集中在「平台访问越权」「DEFINER 越权面」「闸门误伤/失效」
与「迁移触及关键表」。

### 7.1 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **平台越权读到未授权租户数据(最高)** | 高 | 客户授权是唯一入口 + 默认拒绝;`SupportAccessGuard` 逐请求按路由 `:tenantId` + JWT 管理员 id 经 SECURITY DEFINER 校验有效授权,无效即 403;平台读走 `withTenantContext` + RLS(不绕过),只见被授权租户;scope=read_only 由「无任何平台写端点」结构性保证;集成测试钉死 无/过期/撤销/跨租户 → 403(§6.2)。 |
| **SECURITY DEFINER 函数成为越权/注入面** | 中-高 | 函数只接受**服务端传入的已认证管理员 id**(绝不取客户端参)、只回最小列、无有效配对则一无所获;**pin `search_path`**(同 migration 029 对 DEFINER 函数的处理),防 search_path 劫持;`GRANT EXECUTE` 仅给 `kirindesk_app`;code review 红线。 |
| **新增 `audit_logs` INSERT policy 削弱/被滥用** | 中 | 新策略仅允许 `actor_type='platform_admin' AND tenant_id=app_current_tenant_id()`,且该租户上下文**只在授权校验通过后**才设;REVOKE UPDATE/DELETE(023)+ 拒改触发器(022)+ 哈希链不动,append-only 与 `verifyChain` 不受影响;事件带 platform_admin actor、可归因、非伪装成租户用户。 |
| **全局租户状态闸门误伤或失效(fail-open)** | 中 | 一处全局强制、只读 `tenants.status`、**默认 fail-closed**(异常/未知 → 拦截);平台端点不受闸门约束(避免锁死平台自身的启停能力);集成测试钉死 suspend→403 / active→放行 / 平台路径不受影响。 |
| **第二套前端鉴权与租户 token 混淆** | 中 | platform token 独立存储键 + 独立 `platformRequest`/路由树/Context + 独立 401 处理;后端守卫按 token 类型各自拒绝(平台端点要 platform-jwt、租户端点要 tenant-jwt),即便前端串了也被服务端挡下。 |
| **迁移触及关键表(audit_logs 策略、tenants CHECK)** | 中 | 036 全为**加法**:新表、给 audit_logs **加一条 policy**(不动其结构/数据/append-only)、给 tenants **加 CHECK**(现有行皆 active、无回填);可逆 up/down、down 为净移除;CI 校验 up/down/up 干净往返(§6.5)。 |
| **冻结/撤销语义遗漏**(条款被改 or 撤销后仍生效) | 低-中 | 冻结触发器锁死 reason/scope/expires_at/admin/tenant;有效性 = active ∧ 未撤销 ∧ 未过期,三者缺一即拒;测试覆盖 改条款被拒 + 重复撤销 409 + 过期/撤销→403。 |
| **误停用把租户锁死、无法自救** | 低-中 | 停用须带原因且审计、平台可一键复用(可逆);仅平台可停用;客户侧通知留后续(§1.3)。 |
| **`.accessed` 审计噪声**(翻页多读=多条) | 低 | 本阶段每访问一记、求不漏;按会话/时间窗聚合去噪留后续(同 1I `audit.viewed` 取舍)。 |
| **read_only + 受限读集「不够用」诱发未审查扩面** | 低(过程风险) | 扩读集是**显式加端点 + 评审**的刻意动作(§3.8),非配置开关;白名单式增长。 |
| **过期授权以 active 滞留(无清扫)** | 低 | 有效性处处**派生**(守卫 + 前端按 expires_at 现算);后台清扫留后续;测试钉死过期→403。 |

### 7.2 回滚方案

与 1I/1J 的「纯代码回退」不同,本阶段**含迁移 036 + 产品 seed 增量(RBAC 码)+
后端模块/守卫/闸门 + 两个前端面**,回滚分层但仍干净:

- **数据库(migration 036)**:`rollback` 反向执行——丢弃 `support_access_grants`
  (及其索引/RLS/SECURITY DEFINER 函数/冻结触发器)、删 `audit_logs` 的
  `audit_logs_platform_tenant_insert` policy、删 `tenants` 的状态 CHECK。down 为
  **净移除、无需对账**:丢的只是**授权记录**(授权凭证,非业务数据);而这些授权
  产生的**审计事件(granted/revoked/accessed/suspended)留在 `audit_logs`**
  (append-only,删不掉也不该删)——即**回滚后留痕仍在、链仍 PASS**。
- **产品 seed(RBAC 码)**:`support_access:grant/revoke/view` 若已入产品权限字典,
  端点撤除后即**失效空码**,无害;按需在 seed 回退中删除(幂等)。
- **后端**:支持访问 + 平台生命周期模块/控制器/`SupportAccessGuard`/服务,及**全局
  租户状态闸门**的注册——`git revert`。闸门是唯一跨切面件:回退即恢复「不强制
  status」的旧行为;**回退闸门前先把任何 suspended 租户改回 active**(否则其行虽
  仍 `suspended` 但无人强制、等于变相放行,语义不一致)。
- **前端**:租户支持访问页 + 平台控制台(含第二套 Context/路由/token)+ 路由/导航
  ——`git revert`,净移除。
- **下线/拆分粒度**:§1.4 的子阶段切分让**租户生命周期 + 闸门(1K-A)**与**支持
  访问(1K-B)**可独立回退——二者仅共享迁移;若分批上线,可把 036 拆成 036/037 各
  归子阶段,使任一半的回退不留对方的悬挂 schema(仅留无害未用对象时亦可接受)。
- **不可篡改性与既有数据不受影响**:闸门从不写业务数据、支持访问只读、生命周期仅
  改 `status`;无论装上还是回退,`audit_logs`/链/业务表原样不动,`verifyChain`
  结论不因本模块存废而变。

## 8. 验证命令与验收标准

### 8.1 验证命令

**完整质量门槛(提交前置)**

```bash
pnpm verify          # lint + format:check + typecheck + build + unit + integration + security 13
```

**分步 / 定向(开发中)**

```bash
# 仅本模块集成测试
pnpm --filter @kirindesk/api test:integration -- platform-access
# 仅状态机 / 守卫单测
pnpm --filter @kirindesk/api test:unit -- support-access
# 自动修格式(本仓约定:静默修,绿了再报告)
npx prettier --write "apps/api/src/**/*support*.ts" "apps/api/src/**/*tenant-lifecycle*.ts" \
  "apps/web/src/support-access/**/*.tsx" "apps/web/src/platform/**/*.tsx"
# 前端类型 + 构建
pnpm --filter @kirindesk/web build
```

**迁移可逆性(本阶段有迁移 036)**

```bash
# up → down 036 → up 干净往返;down 后无悬挂对象
pnpm --filter @kirindesk/database migrate
pnpm --filter @kirindesk/database rollback   # 反向到 036 之前
pnpm --filter @kirindesk/database migrate
# 校验对象存在性(up 后应有、down 后应无):
#   表 support_access_grants、其 RLS policy/索引/冻结触发器、
#   函数 app_lookup_support_grant / app_list_support_grants_for_admin、
#   audit_logs 的 audit_logs_platform_tenant_insert policy、tenants 的状态 CHECK
```

**本地冒烟(两套身份;⚠️ 只对「丢弃用租户」做 suspend,勿停 dev-tenant)**

```bash
# 租户侧:授权 → 列表 → 撤销
TOK=$(curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"dev-password-123","tenantSlug":"dev-tenant"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s -X POST localhost:3001/api/support-access -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"platformAdminEmail":"<平台管理员邮箱>","reason":"排障","scope":"read_only","expiresAt":"<未来ISO>"}'
curl -s -H "Authorization: Bearer $TOK" localhost:3001/api/support-access

# 平台侧(平台管理员凭据见 dev seed / .env):清单 / 启停 / 我的授权 / 受授权只读
PTOK=$(curl -s -X POST localhost:3001/api/platform-auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<平台管理员邮箱>","password":"<平台密码>"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
curl -s -H "Authorization: Bearer $PTOK" localhost:3001/api/platform/tenants
curl -s -H "Authorization: Bearer $PTOK" localhost:3001/api/platform/support-grants
# 无授权 → 403;有授权 → 200(只读该租户审计)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PTOK" \
  "localhost:3001/api/platform/tenants/<被授权租户id>/audit-logs"

# 闸门 + 链:停用丢弃用租户后其用户请求 → 403;访问后租户链仍 PASS
pnpm db:verify-chain tenant:00000000-0000-0000-0000-000000000001   # 平台访问后应仍 PASS
```

**前端浏览器 QA**:Playwright 跑 §6.4(两套身份),产出截图(租户授权/撤销、平台
生命周期、受授权只读视图 + 横幅、两类 403),并 grep 页面源做隐私 spot-check。

### 8.2 验收标准(全部满足方算完成)

**后端 — 支持访问**

- [ ] `POST /api/support-access`、`GET /`、`GET /:id`、`POST /:id/revoke` 存在并按
      `support_access:grant/view/revoke` 守卫;无 token 401、无权 403、未知邮箱 404、
      过去 `expiresAt` 400、重复 active 409、非法转换 409。
- [ ] 平台 **无/过期/撤销** 授权读租户数据 → 403;**有效** → 200 且**仅**该租户、
      只读;跨租户 → 403;`support-grants` 只列指名本人的授权。
- [ ] SECURITY DEFINER 函数只用**服务端传入的已认证管理员 id**、pin `search_path`;
      冻结触发器拒改授权条款(仅 status/revoked_* 可改);**scope=read_only** 由
      无任何平台写端点结构性保证。

**后端 — 租户生命周期 + 闸门**

- [ ] 平台 `GET /api/platform/tenants`、`/:id` 仅元信息(无业务数据);
      `PATCH /:id/status` 带 reason、active↔suspended、同态 409。
- [ ] **全局闸门**:非 active 租户的租户用户请求(含登录)→ 403「租户已停用」;
      active → 放行;平台端点不受闸门约束;默认 **fail-closed**。

**审计**

- [ ] `support_access.granted/.revoked/.accessed`、`tenant.suspended/.activated`
      全部落**租户链**,`actor_type` 正确(accessed/suspended/activated=
      platform_admin);metadata 仅标识 + 授权条款,**无业务明文**;租户在 1I 可见;
      `verifyChain` PASS;`AuditService`/哈希/append-only 未动(仅新增一条 INSERT
      policy)。

**迁移**

- [ ] `036` up 建齐(表 + RLS + 索引 + 2 个 DEFINER 函数 + 冻结触发器 +
      audit_logs INSERT policy + tenants CHECK);down 全净移除;up/down/up 干净往返。

**测试与门槛**

- [ ] `pnpm verify` 全绿:含 platform-access 集成 + 状态机/守卫单测;security 13/13。
- [ ] (可选)安全回归追加:冻结触发器拒改条款、新 audit_logs policy 不附带
      UPDATE/DELETE。

**前端**

- [ ] 租户 `/support-access`:授权(平台管理员邮箱/原因/范围/到期)+ 列表(**派生**
      生效中/已过期/已撤销)+ 撤销;无权整页 403;导航「支持访问」;跳转 1I 看
      平台访问。
- [ ] 平台控制台:独立 `/platform` 登录 + 布局 + 独立 token;租户清单 + 启停;
      「我的授权」;受授权只读视图带「访问已被记录」横幅、**零写控件**;无授权 403。
- [ ] 隐私 spot-check:零 `console.*`、敏感内容不入 localStorage/sessionStorage/URL、
      平台 token 独立键;纯加法、无新依赖。

**流程(CLAUDE.md §1/§9)**

- [ ] 实施前本规划(§1–§8)经用户确认;若按 §1.4 拆分(1K-A 生命周期+闸门 /
      1K-B 支持访问),分批推进、各自验收。
- [ ] 完成后按 §9 报告:新增 / 修改 / 删除文件、执行命令、测试结果、是否动 schema
      (**是:迁移 036**)、是否产生 secret(否)、遗留风险、建议下一步。

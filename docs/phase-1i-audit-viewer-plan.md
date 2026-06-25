# Phase 1I 规划 — 审计日志查看器(Audit Log Viewer)

复用既有 `audit_logs` + `audit_log_chains` 两张表(migration 015/016)与既有
哈希链写入 / 校验设施,**只读消费**,不新建表、不改写入路径。本文档逐节确认后
再实施;本次仅写 §1。

## 1. 目标与范围

### 1.1 背景与目标

KirinDesk 的审计基础设施在 Phase 0 就已落地且持续被各业务模块写入:append-only
的 `audit_logs`(migration 016,`bigserial` 主键)+ 每链 `audit_log_chains`
(migration 015,`chain_key` = `tenant:<tenantId>` 或 `platform`,保存
`last_log_id` / `last_hash`),由 `AuditService.writeToChain` 以 SHA-256
**哈希链**串接(`prev_hash` → `row_hash`,链头 `FOR UPDATE` 串行化),并以
数据库层 **REVOKE UPDATE/DELETE**(migration 023)+ **BEFORE UPDATE/DELETE
触发器拒绝**(migration 022)+ **FORCE RLS 租户读隔离**(migration 021)三重
保证不可篡改;`packages/database/src/verify-chain.ts` 的 `verifyChain(chainKey)`
能重算每行哈希、校验 `prev_hash` 链接,返回 `{ ok, total, failedAt }` 并以
CLI 打印 PASS/FAIL。

到目前为止,**这套设施完全没有产品内入口**:用户 / 角色变更、文件上传下载、
订单与审批、提成锁定 / 发放、AI/OCR 调用、登录、权限拒绝等事件都已忠实写入
`audit_logs`,但租户管理员、财务、合规人员无法在产品里查看「谁在何时对什么做了
什么」,也看不到「这条链未被篡改」的证据。这正是 CLAUDE.md §3/§6 反复强调的
"可审计 / controllable / auditable"信任承诺——**已经建好却不可见**。

本阶段目标:补上这个半成品闭环的收尾——给持有 `audit_logs:view` 权限的租户用户
一个**只读**的产品内审计日志查看界面,能按维度检索审计事件、查看单条事件的
before/after 变更明细,并展示**本租户审计链的完整性校验结果**(PASS/FAIL),
把已有的不可篡改证据真正呈现给客户。

### 1.2 本阶段要做(范围内)

- **后端只读端点**(新 `audit` 读取模块或 `audit` 现有模块下新增 controller,
  实施时定):`@Controller('api/audit-logs')`,在 `TenantAuthGuard +
  PermissionGuard` 下,按 `audit_logs:view` 守卫,RLS 租户隔离:
  - 列表:分页 + 过滤(actor_id、action、resource_type / resource_id、时间范围
    from/to;具体过滤集 §3 定),按 `created_at` / `id` 排序,响应经 mapper
    塑形(暴露事件标识 + before/after/metadata,不泄漏内部不需要的列)。
  - 单条:getOne 返回一条审计事件的完整 before/after/metadata 明细。
  - **链完整性校验**:复用 `verifyChain` 逻辑,对本租户链
    (`tenant:<tenantId>`)返回 `{ ok, total, failedAt? }`,供前端展示
    "审计链校验 PASS / 共 N 条"。
- **Web 页面**(`apps/web/src/audit/`,沿用既有列表 / 详情 + api-client + 行内
  样式 + 中文 + 403 优雅降级约定):审计日志列表(时间 / 操作者 / 动作 / 资源 /
  结果)+ 过滤器 + 单条详情(before/after 差异展示)+ 顶部「审计链完整性」
  状态指示;无 `audit_logs:view` → 403 整页降级;导航入口。
- **dataScope 与隔离**:读端点把 `req.dataScope`(PermissionGuard 注入)纳入
  考虑;审计查看属管理 / 合规职能,scope 语义(all 看全租户、own 退化为只看
  与自己相关事件)在 §3/§4 钉死。跨租户由 FORCE RLS 兜底,别租户行天然不可见。

### 1.3 本阶段不做(范围外)

- **不改审计写入路径**:不动 `AuditService.writeToChain`、不改哈希算法 /
  `hash_version` / 链结构 / canonicalize 规则,不新增任何审计事件类型。查看器
  纯粹是 `audit_logs` 之上的**读取消费者**。
- **零 migration、零新权限码**:`audit_logs:view` 已在 system 模块(id …007)
  seed(同 1H 复用既有码的做法),`audit_logs` / `audit_log_chains` 表结构、
  索引、RLS policy、append-only 约束一律不动。
- **不做导出**:审计日志的 CSV/Excel 导出留给后续候选(Phase 1I 之后的"数据
  导出"模块),本阶段只做产品内只读查看。
- **不做编辑 / 删除 / 脱敏 / 重算修复**:append-only 不可篡改是本设施的根本,
  查看器绝不提供任何写、改、删、redact 或链修复入口。
- **不做平台侧(platform-admin)跨租户审计控制台**:平台管理员对租户审计的
  访问另有授权 / 审计要求(CLAUDE.md §3),`platform` 链与 NULL-tenant 事件的
  查看不在此阶段;本阶段只做**租户内**自查。
- **不做实时流 / 告警 / 订阅**:只做按需查询的列表 + 详情 + 一次性链校验。

### 1.4 与既有审计基础设施 / 哈希链 / verify-chain 的关系

本阶段是既有审计设施的**纯只读上层**,严格复用、绝不修改:

- **数据源**:直接读 `audit_logs`(016)。该表已被所有已完成阶段写入,数据丰富,
  无需新增列或回填。
- **租户隔离**:复用 migration 021 的 `audit_logs_tenant_read` RLS policy
  (`tenant_id = app_current_tenant_id()`),经 `withTenantContext` 设上下文后,
  查看器查询天然只见本租户事件;无需也不会引入新 policy。
- **不可篡改保证不被削弱**:`app` 角色(`kirindesk_app`)对 `audit_logs` 已被
  REVOKE UPDATE/DELETE(023)且有触发器拒绝(022),查看器走同一角色,因此**在
  数据库层就不可能**经查看器写 / 改 / 删审计行——这是设计而非约定。
- **链完整性**:复用 `packages/database/src/verify-chain.ts` 的
  `computeRowHash` / `verifyChain` 算法(重读存储的 jsonb、按
  `hash_version|prev_hash|tenant_id|...|created_at` 重算 SHA-256、校验
  `prev_hash` 链接),对本租户 `chain_key = tenant:<tenantId>` 给出 PASS/FAIL +
  total + failedAt。实施时是把该逻辑作为服务方法供 API 调用,还是复用包导出,
  在 §3 定;无论哪种,算法与既有 CLI(`pnpm db:verify-chain`)保持一字节一致,
  以免出现"CLI PASS、页面 FAIL"的口径漂移。
- **净增**:仅新增"读取 + 展示"代码(后端只读 controller/service + 前端页面 +
  api-client),不触碰 schema、写入、密钥、provider。与 1H 同构,属低风险小步。

## 2. 数据模型与复用

本阶段**零 migration**:所需两张表 + 写入 / 校验设施均已存在。下面逐项说明形状、
本阶段如何只读使用,以及一处必须显式处理的隔离细节(`audit_log_chains` 无 RLS)。

### 2.1 既有表 `audit_logs`(migration 016)

事件主表,`bigserial id` 单调递增即写入顺序;`hash_version` / `prev_hash` /
`row_hash` 是哈希链字段(§2.4)。列与本阶段用途:

| 列 | 类型 | 本阶段用途 |
|---|---|---|
| `id` | bigserial PK | 排序键 + 游标 + getOne 定位;响应里作为事件 id。 |
| `tenant_id` | uuid (可空) | RLS 隔离依据;租户事件非空,平台事件为 NULL(本阶段只读本租户非空行)。 |
| `actor_type` | varchar(20) | 操作者类型(`tenant_user` / `platform_admin` / `system`);可作过滤 + 展示。 |
| `actor_id` | uuid NOT NULL | 操作者 id;过滤(按人查)+ 展示;前端可 join 出姓名(§5 定)。 |
| `action` | varchar(100) | 动作码(如 `user.created` / `role.permissions_replaced` / `file.downloaded`);核心过滤 + 展示维度。 |
| `resource_type` | varchar(100) | 资源类型(`user` / `role` / `file` / `sales_order` …);过滤 + 展示。 |
| `resource_id` | varchar(100) (可空) | 资源 id;按资源追溯(配合 resource_type)。 |
| `before_json` / `after_json` | jsonb (可空) | 变更前 / 后快照;**详情页 diff 的数据源**(权限变更等正是 §6 要求的可追溯证据)。 |
| `metadata_json` | jsonb (可空) | 附加上下文(各模块自填);详情展示。 |
| `request_id` | varchar(50) (可空) | 关联同一请求的多条事件;可作过滤 / 分组。 |
| `ip_address` / `user_agent` | varchar(45)/(500) (可空) | 来源信息;详情展示(列表默认不展开)。 |
| `reason` | varchar(500) (可空) | 敏感操作的理由(如 unlock / reject);详情展示。 |
| `row_hash` / `prev_hash` / `hash_version` | varchar(64)/(64)/smallint | 哈希链字段;**链校验用**(§2.4),一般不直接展示给业务用户(可在详情/调试视图可选呈现,§5 定)。 |
| `created_at` | timestamptz | 事件时间;默认排序键 + 时间范围(from/to)过滤 + 展示;也是哈希输入的一部分。 |

- **响应塑形**:mapper 暴露上表中"展示 / 过滤"用途的列。`row_hash` / `prev_hash`
  是否进响应在 §5 定;无论如何**只读**,不接受任何写。
- **绝不返回的东西**:本表本身不含密码 / 密钥;但 `before/after/metadata` 是各
  模块自填的快照,既有写入方已遵循"只记标识与摘要、不记密码 / 不记业务明文"
  (见各阶段审计约定),查看器原样只读呈现,不二次加工、不外发。

### 2.2 既有表 `audit_log_chains`(migration 015)

每条哈希链一行,`chain_key` 唯一:租户链为 `tenant:<tenantId>`,平台链为
`platform`;保存 `last_log_id` + `last_hash`(链尾)。本阶段用途:**链完整性
校验的入口**——`verifyChain` 先按 `chain_key` 取到该链的 `tenant_id`,再据此
拉取 `audit_logs` 全量重算(§2.4)。

- ⚠️ **隔离细节(必须显式处理)**:`audit_log_chains` **没有启用 RLS**(只有
  `audit_logs` 在 migration 021 加了 FORCE RLS),`app` 角色对它有 SELECT,
  因此能读到任意租户的链行。所以查看器**绝不能接受客户端传入的 `chain_key`**,
  必须在服务端用**已认证的调用者 tenantId** 拼出 `tenant:<callerTenantId>`
  去校验。这样既不泄漏他租户链是否存在,也不会越权校验别人的链。

### 2.3 既有索引与过滤的对应

migration 016 已建索引,本阶段的过滤设计应尽量贴合,避免全表扫:

- `idx_audit_logs_tenant_created (tenant_id, created_at)` → 默认列表(本租户 +
  时间倒序 + 时间范围)走此复合索引,是主路径。
- `idx_audit_logs_actor_id (actor_id)` → 按操作者过滤。
- `idx_audit_logs_resource (resource_type, resource_id)` → 按资源追溯过滤。
- `idx_audit_logs_request_id (request_id)` → 按请求分组 / 过滤。
- `idx_audit_logs_created_at (created_at)` → 纯时间范围(无租户维度,主要服务
  平台侧;本阶段租户内查询优先用上面的复合索引)。
- **缺口提示**:`action` **无单列索引**。若 §3 要支持按 action 过滤,要么接受
  在 `(tenant_id, created_at)` 缩窄后的结果集上再过滤 action(数据量可控时
  可接受),要么在 §5/§3 评估是否需要新增索引——但**新增索引=migration**,
  与"本阶段零 migration"冲突,默认**不加**,改用"时间窗 + 应用层 action 过滤"
  的最简实现,留作后续优化项(实施时在 §3 钉死)。

### 2.4 既有写入 / 校验设施(只复用,不修改)

- **写入**:`AuditService.writeToChain`(`apps/api/src/audit/audit.service.ts`)
  在一个事务里 `FOR UPDATE` 锁链头、按
  `hash_version|prev_hash|tenant_id|actor_type|actor_id|action|resource_type|
  resource_id|canonical(before)|canonical(after)|canonical(metadata)|request_id|
  ip|user_agent|reason|created_at(ISO)` 算 SHA-256 写入。**本阶段完全不碰它**。
- **校验**:`packages/database/src/verify-chain.ts` 的 `computeRowHash` /
  `verifyChain(chainKey)` 按 `id ASC` 重读存储的 jsonb、逐行重算哈希并校验
  `prev_hash` 链接,返回 `{ ok, total, failedAt? }`;CLI(`pnpm db:verify-chain
  <chainKey>`)打印 PASS/FAIL。本阶段把**同一算法**用于 API 的链校验端点
  (作为服务方法引入还是复用包导出,§3 定),要求与 CLI **逐字节一致**,杜绝
  "CLI PASS、页面 FAIL"的口径漂移。
- **不可篡改保证**:`app` 角色对 `audit_logs` 被 REVOKE UPDATE/DELETE
  (migration 023)+ BEFORE UPDATE/DELETE 触发器拒绝(migration 022);查看器走
  同一角色,**数据库层**即不可能经其写 / 改 / 删审计行。

### 2.5 读取上下文与 RLS 复用

- 所有读经 `withTenantContext`(设 `app.current_tenant_id` /
  `app.current_actor_type`),让 migration 021 的 `audit_logs_tenant_read`
  policy(`tenant_id = app_current_tenant_id()`)生效,查询天然只见本租户事件。
- `app` 角色对 `audit_logs` 有 SELECT(migration 000 默认授予,且未被 023 收回
  SELECT,只收回了 UPDATE/DELETE),读取无授权障碍。
- 跨租户 id(getOne 命中别租户行)由 RLS 兜底返回空 → 映射为不透明 404,不泄漏
  存在性(同既有模块约定)。

### 2.6 不需要的变更

- 无新表、无新列、无新索引、无新约束、无新 RLS policy → **无 migration**。
- 无新权限码(`audit_logs:view` 已 seed 于 system 模块 id …007)。
- 不改 `AuditService`、不改哈希算法 / `hash_version` / 链结构、不改 `verify-chain`
  逻辑、不改 append-only 约束与触发器。

## 3. 后端 API 端点

一个只读控制器,`@Controller('api/audit-logs')`,全部 `@UseGuards(TenantAuthGuard,
PermissionGuard)`,按 `audit_logs:view` 守卫,DTO 走全局 ValidationPipe
(whitelist + forbidNonWhitelisted + transform),响应经 mapper 塑形,读经
`withTenantContext` 让 RLS 生效。**纯只读**:无任何 POST/PATCH/PUT/DELETE
业务写,无审计写入(§3.5)。与既有 reports / commission 只读端点同构。

### 3.1 端点一览

| 方法 & 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/audit-logs` | `audit_logs:view` | 列表(分页 page/pageSize;过滤 from/to 时间范围、actorId、actorType、action、resourceType、resourceId、requestId);`created_at DESC, id DESC` 排序;dataScope 推入 WHERE;响应 `{ data, page, pageSize, total }`。 |
| `GET /api/audit-logs/chain/verify` | `audit_logs:view` | 本租户审计链完整性校验:服务端用调用者 tenantId 拼 `tenant:<tenantId>` 调 `verifyChain`,返回 `{ ok, total, failedAt? }`。**静态路由必须声明在 `:id` 之前**(或 `:id` 限定为数字),否则 `chain` 会被当作 id。 |
| `GET /api/audit-logs/:id` | `audit_logs:view` | 单条事件完整明细(含 before/after/metadata);`id` 为 bigint(数字参数,**非 UUID**);dataScope + RLS 命中失败 → 不透明 404。 |

> 说明:三个路由共用 `audit_logs:view`;链校验不另立权限码(本阶段不新增码)。
> 排序加 `id` 次级键,保证同一 `created_at` 下顺序稳定(分页不跳行)。

### 3.2 列表查询 DTO 与过滤

`ListAuditLogsQuery`(class-validator + class-transformer):

- `page?` / `pageSize?`:`@Type(()=>Number) @IsInt @Min(1)`,pageSize 另加
  `@Max(100)`;默认 page=1、pageSize=20。
- `from?` / `to?`:`@IsISO8601`,作 `created_at >= from` / `created_at <= to`;
  二者皆可选,缺省不限时间(实施时可给"默认最近 N 天"的兜底,§5 定)。
- `actorId?`:**`@IsUUID()`(任意版本,不锁 '4')**——汲取 1H 教训:种子 / 历史
  actor 可能是非 v4 的合成 UUID,锁 v4 会误拒合法过滤值。
- `actorType?`:`@IsIn(['tenant_user','platform_admin','system'])`(本阶段只读
  本租户,实际多为 tenant_user / system)。
- `action?` / `resourceType?`:`@IsString @MaxLength(100)`,精确匹配。
- `resourceId?`:`@IsString @MaxLength(100)`(资源 id 是 varchar,不一定是 UUID,
  不锁 UUID)。
- `requestId?`:`@IsString @MaxLength(50)`。

**过滤一律下推到 SQL WHERE**(正确性不依赖索引):默认查询先由
`idx_audit_logs_tenant_created (tenant_id, created_at)` 把"本租户 + 时间窗"缩到
小结果集,再在其上用 `action = $n` 等条件过滤——`action` 无单列索引(§2.3),但
在已缩窄的集合上过滤代价可控,**本阶段不为 action 加索引(=不引 migration)**,
留作后续优化。无自由文本搜索(无相应索引,且 before/after 是 jsonb,全文检索
超出范围)。

### 3.3 响应塑形(mapper)

列表行与详情共用一个 mapper,暴露:`id`(转 string,避免 JS bigint 精度问题)、
`tenantId`、`actorType`、`actorId`、`actorName`、`action`、`resourceType`、
`resourceId`、`createdAt`,详情再附 `before` / `after` / `metadata` / `reason` /
`requestId` / `ipAddress` / `userAgent`。

- **`actorName`**:对 `actor_type='tenant_user'` 的行,`LEFT JOIN users u ON
  u.id = actor_id`(同租户,RLS 安全)取 `u.name` 提升可读性;非 tenant_user
  (platform_admin / system)或已删用户 → `null`,前端回退展示 actorId。
- **`row_hash` / `prev_hash` / `hash_version`**:默认**不进**业务响应(对终端
  用户无意义);是否在详情提供一个可选的"技术 / 校验视图"字段,§5 定。无论
  如何只读。
- **不二次加工 before/after/metadata**:原样回传既有 jsonb 快照,查看器不解析、
  不改写、不外发。

### 3.4 链校验端点语义

`GET /api/audit-logs/chain/verify` 复用 §2.4 的 `verifyChain` 算法(作为只读
服务方法引入,与 CLI 逐字节一致),`chain_key` **只由服务端按已认证 tenantId
拼出**,绝不接受客户端传参(§2.2 的无-RLS 隔离细节)。返回
`{ ok: boolean, total: number, failedAt?: { id, reason } }`。

- **复杂度提示**:`verifyChain` 是 O(n) 全链重算,链很长时偏重。本阶段接受
  整链按需校验(链规模可控);增量 / 缓存 / 抽样校验留作后续优化(不在本阶段)。
- 该端点**不**修复、不重算落库、不暴露逐行哈希列表,只给聚合结论 + 首个失败点。

### 3.5 dataScope、隔离与"读不审计"

- **dataScope**:`PermissionGuard` 注入的 `req.dataScope` 推入 WHERE。
  `all` → 看全租户事件;`own` → 退化为"仅自己发起的操作"即 `actor_id = caller`
  (审计行不带资源 owner 字段,无法按"我拥有的资源"过滤,故 own 锚定到
  actor)。精确语义在 §4 钉死,§3 仅实现其下推。
- **跨租户**:`withTenantContext` + `audit_logs` FORCE RLS 兜底,别租户行不可见;
  getOne 命中别租户 / 不存在 → 不透明 404。
- **读不写审计**:本阶段查看审计**本身不写审计事件**,沿用既有"读端点不审计"
  约定(reports / commission 读均不审计),也避免查看动作自增链噪声。"谁查看了
  审计日志"作为更敏感的访问留痕需求,留作后续(需确认后再定),§4 复述。

### 3.6 服务层

新增只读 `AuditQueryService`(`apps/api/src/audit/` 下,与既有写入用
`AuditService` **分开**,后者一字不改),`@Inject(APP_POOL)` + `withTenantContext`:

- `list(actor, query)`:构造 WHERE(dataScope + 过滤)、COUNT + 分页 SELECT
  (含 actorName 的 LEFT JOIN),返回 `{ data, page, pageSize, total }`。
- `getOne(actor, id)`:按 id 取单行(RLS + dataScope),无 → `AuditLogNotFound`
  → 404。
- `verifyTenantChain(actor)`:用 `tenant:<actor.tenantId>` 调 verify 算法,返回
  `{ ok, total, failedAt? }`。

> 分页用 offset + COUNT 的最简实现(同既有列表)。append-only 表会持续增长,
> 大数据量下 offset + COUNT 偏重;游标(按 id)分页作为后续优化,本阶段不做。

### 3.7 不做的端点

- 无 create / update / delete / redact(append-only,数据库层也禁止)。
- 无导出端点(CSV/Excel 留后续"数据导出"模块)。
- 无平台侧跨租户审计查询端点(`platform` 链 / NULL-tenant 事件不在本阶段)。
- 无链修复 / 重算落库 / 逐行哈希导出端点。
- 无实时流 / 订阅 / 告警端点。

## 4. 安全护栏与审计

审计查看器读的是**最敏感的元数据**(谁在何时对什么做了什么),且其底层是
不可篡改的信任凭证。本阶段是只读模块,护栏重心从 1H 的"写入提权防护"转为
**隔离、最小泄漏面、不可削弱不可篡改性**。所有判定在服务端强制(CLAUDE.md §4:
UI 隐藏不是安全边界)。

### 4.1 护栏(服务端强制)

1. **租户隔离(核心)**:三个端点全部经 `withTenantContext` + `audit_logs`
   FORCE RLS 的 `audit_logs_tenant_read` policy(`tenant_id =
   app_current_tenant_id()`),查询天然只见本租户事件;任何 id / 过滤都不能
   越租户取数。跨租户 getOne → 不透明 **404**,不泄漏存在性。
2. **`chain_key` 必须服务端派生(关键)**:`audit_log_chains` **无 RLS**、
   `app` 角色可读任意链(§2.2),因此链校验端点**绝不接受客户端传入
   `chain_key`**,只用已认证调用者的 tenantId 拼 `tenant:<tenantId>`。杜绝
   "传 `tenant:<别人>` 或 `platform` 来探测 / 校验他人链"。端点签名里**没有**
   chain_key 入参,从源头上不可越权。
3. **append-only / 不可篡改不被削弱**:查看器走与写入相同的 `app` 角色,该角色
   对 `audit_logs` 已被 REVOKE UPDATE/DELETE(023)+ 触发器拒绝(022);本阶段
   **不新增任何写 / 改 / 删 / redact 端点**,数据库层与应用层双重保证查看器
   无法动审计行。
4. **dataScope 语义钉死**:`all` → 看本租户全部事件;`own` → **仅 `actor_id =
   caller` 的事件**(即"我发起的操作")。审计行不携带资源 owner 字段,无法表达
   "我拥有的资源的相关事件",故 own **只锚定到 actor**,不做更复杂的资源归属
   推断。`none` → 无 `audit_logs:view`,根本进不来(被 PermissionGuard 403)。
5. **不放大泄漏面**:mapper 只读既有列(§3.3);`before/after/metadata` 原样
   回传——既有写入方已遵循"只记标识与摘要、不记密码 / 不记业务明文",查看器
   不二次解析、不补字段、不外发;`row_hash` / `prev_hash` / `hash_version`
   默认不进业务响应(对外无意义,也不必把链内部喂给潜在攻击者);`id` 以
   string 返回,避免 JS bigint 精度丢失导致取错行。
6. **权限服务端强制**:`audit_logs:view` 由 `@RequirePermission` +
   PermissionGuard 判定;前端的 403 优雅降级只是体验,**不是**边界——无权用户
   即便直连 API 也拿不到任何审计数据。
7. **输入校验 + 防注入**:DTO whitelist + forbidNonWhitelisted 丢弃未知字段;
   `actorId` 用任意版本 `@IsUUID()`(不锁 v4,汲取 1H 误拒教训);`from/to`
   `@IsISO8601`;`actorType` 白名单;所有过滤值经**参数化查询**下推,绝不字符串
   拼接(防 SQL 注入)。
8. **链校验只读结论**:verify 端点只回 `{ ok, total, failedAt? }` 聚合结论 +
   首个失败点,不导出逐行哈希、不提供修复 / 重算落库入口。

### 4.2 审计(CLAUDE.md §6)

- **本阶段查看审计本身不写审计事件**:沿用既有"读端点不审计"约定(reports /
  commission 读均不审计),并避免查看动作向同一条哈希链自增噪声。
- **被拒访问已自带留痕**:既有 PermissionGuard 在权限不足时已写
  `rbac:permission_denied` 审计——无 `audit_logs:view` 的用户访问这些端点命中
  403 时,同样在 `audit_logs` 里留下可追溯证据,无需本阶段补记。
- **"谁查看了审计日志"列为后续**:这是更敏感的访问留痕需求(看审计的人也该被
  审计)。若将来要做,应作为**新 action**(如 `audit.viewed`)经既有
  `AuditService` 写入同一链,并设计去噪策略(如按会话 / 时间窗聚合,避免每次
  翻页都写一条);本阶段不做,需求确认后再立子阶段。
- **不改写入路径 / 链结构**:重申 §2.6——`AuditService`、哈希算法、`hash_version`、
  链结构、append-only 约束与触发器一律不动,查看器的引入不改变任何既有审计的
  生成与可验证性。

### 4.3 验证这些护栏(集成测试覆盖,§7 详列)

- **跨租户隔离**:A 租户 token 的 list 不含 B 租户事件;getOne 一条 B 租户事件
  id → 404;过滤参数无法跨租户取数。
- **`chain_key` 不可越权**:verify 端点无 chain_key 入参,只校验本租户链;不同
  租户调用各自得到各自链的结论,互不可见。
- **dataScope**:`own` 用户的 list / getOne 只见 `actor_id = 自己` 的事件;`all`
  用户见全租户事件。
- **RBAC 401/403**:无 token → 401;有 token 但无 `audit_logs:view` → 403,且
  该 403 命中既有 `rbac:permission_denied` 留痕。
- **只读不可写**:模块无任何写端点;复述既有 022/023 断言(`app` 角色
  UPDATE/DELETE `audit_logs` 被拒)证明查看器路径下审计行不可变。
- **链校验一致性**:verify 端点对本租户链返回的 `{ ok, total }` 与 CLI
  `pnpm db:verify-chain tenant:<id>` 逐字节一致;篡改一行后既有 verify-chain
  测试给出 FAIL + failedAt(算法层已覆盖),端点层断言其结构透传。
- **bigint 精度**:`id` 以 string 返回,大 id 不丢精度、getOne 能据其精确命中。

## 5. 前端页面与导航

沿用既有 `apps/web/src/<module>/` + `App.tsx` 路由 + `AppLayout` 扁平导航 +
`request<T>()` / `apiClient` + `ApiError` 按 status 映射文案 + 行内
`CSSProperties` 中文 + 403 优雅降级的约定(同 reports / commission / AI 页)。
纯前端,无新依赖。

### 5.1 页面

**审计日志**(`apps/web/src/audit/`):

- `AuditLogsPage.tsx`(路由 `/audit-logs`):一个页面承载全部能力——
  顶部「审计链完整性」状态条 + 过滤器 + 事件列表 + **页内详情面板**(选中某行
  → `getOne` → 展示 before/after 变更),与 AI 页"列表 + page-local getOne 详情"
  同构,不另立详情路由(只读查看,URL 可分享性需求低;若后续需要再拆)。
  无 `audit_logs:view` → **整页 403 优雅降级**(`forbidden` 状态,整页提示
  「没有权限查看审计日志」,同 reports/AI 页的 graceful-403)。

### 5.2 审计链完整性状态条(信任承诺的可见化)

页面挂载时调 `GET /api/audit-logs/chain/verify`,在顶部渲染一条状态:

- `ok` → 绿色「审计链完整 ✓ 共 N 条」(N = `total`)。
- `!ok` → 红色「审计链校验失败:id=`failedAt.id`(`failedAt.reason`)」。
- 403 → 与列表同走整页降级;其他错误 → 灰色「链状态暂不可用」(不阻塞列表)。

这正是把 §1 的"已建好却不可见"的不可篡改证据**呈现给客户**——是本阶段的核心
价值点,放在最显眼处。

### 5.3 过滤器(默认窗 + 应用态)

过滤行(草稿态输入 + 「筛选」提交后写入 applied 态驱动 fetch,同 CustomersList
约定):

- **时间范围 from/to**(`<input type="date">`):**默认最近 7 天**(钉死 §3.2 的
  "默认最近 N 天兜底",N=7),以约束高写入量表的默认结果集;用户可自行放宽。
- **actorType**:下拉(全部 / tenant_user / platform_admin / system)。
- **action**:文本精确匹配(如 `user.created`);占位提示给常见值示例。
- **resourceType**:文本 / 下拉(user / role / file / sales_order …);
- **resourceId**:文本;
- **requestId**:文本(按一次请求归并查看)。

分页:`上一页 / 第 X / Y 页 / 下一页`,pageSize=20(同既有列表)。

### 5.4 列表列与详情

- **列表列**:时间(`createdAt`)、操作者(`actorName` ?? `actorId`,后附
  `actorType` 小标签)、动作(`action`)、资源(`resourceType` + `resourceId`)、
  请求(`requestId`,可截断)。点击行 → 加载并展开详情面板。
- **详情面板(before/after diff)**:本阶段查看器的"读"价值集中在变更明细——
  - 主视图:**字段级 diff**——并列「变更前 / 变更后」,对 `before_json` /
    `after_json` 的并集 key 标注 新增 / 移除 / 变更(权限 / 角色 / 用户变更的
    差异正是 §6 要的可追溯证据);
  - 附:`metadata` / `reason` / `ipAddress` / `userAgent` 原样只读展示;
  - 兜底:对结构复杂或无法 diff 的快照,回退为格式化 JSON 的 `<pre>` 并排呈现。
- **不展示逐行哈希**:`row_hash` / `prev_hash` / `hash_version` **不在列表 / 详情
  呈现**(默认也不在响应,§3.3/§4.1.5)——链可信度由 §5.2 的整链校验状态条
  传达,而非把链内部喂给界面;本阶段不做"技术 / 哈希视图"。

### 5.5 api-client / 类型扩展

`lib/types.ts` 新增(镜像后端 mapper 形状,§3.3):`AuditLogSummary`
(id:string、tenantId、actorType、actorId、actorName、action、resourceType、
resourceId、createdAt)、`AuditLogDetail`(extends Summary + before/after/
metadata/reason/requestId/ipAddress/userAgent)、`ListAuditLogsQuery`、
`AuditChainVerifyResult`(`{ ok, total, failedAt? }`);分页复用 `Paginated<T>`。

`lib/api-client.ts` 新增三个方法(走既有 `request<T>()`,查询串用
`URLSearchParams` helper 同 `listFiles` / `commissionQs`):
`listAuditLogs(query)` / `getAuditLog(id)` / `verifyAuditChain()`。

### 5.6 导航与路由

- `App.tsx`:在受保护布局下加 `<Route path="/audit-logs" element={<AuditLogsPage/>}/>`。
- `AppLayout.tsx`:加一个导航链接「审计」(`/audit-logs`),沿用应用既有的
  **always-show + 服务端 403 优雅降级**约定(不做权限门控隐藏——`/api/auth/me`
  不带权限码,且 UI 隐藏非安全边界,§4);无权用户点进去落到整页「没有权限」。

### 5.7 只读与隐私

- 页面**纯只读**:无任何创建 / 编辑 / 删除 / 导出控件(导出留后续模块)。
- 审计内容(含 before/after 快照)仅存在于 React 状态用于展示,前端**不**写入
  localStorage / sessionStorage / URL / console;刷新即重新拉取。与 AI 页的
  隐私约定一致。

## 6. 测试

后端以 **vitest 集成测试**为主(`apps/api/test/audit.integration.test.ts`,
supertest 打真实 HTTP,跑在 `kirindesk_test`,复用 `setup-integration` +
`fixtures`),覆盖只读语义、dataScope、跨租户隔离、RBAC、链校验与 bigint 精度;
前端走浏览器 QA(Playwright,本环境已可用)。提交前置仍是 `pnpm verify` 全绿。

### 6.1 测试前置:fixture 扩展(仅测试夹具,非产品 migration)

- **授予 `audit_logs:view`**:现有 `SEED_PERMS` 未含该码——在 fixture 的
  `SYSTEM_MODULE_ID` 下加入 `audit_logs:view`,使 admin 角色(scope=all)、sales
  角色(scope=own)、tenant2-admin(all)拿到它;`TEST_USER4`(无角色)保持无权。
  产品 seed 早已有该码(§2.6),这里只是测试夹具补授权,**不改产品 seed、不引
  migration**。
- **造审计数据**:用既有**被审计的写端点**产生真实、链合法的事件——例如以
  admin 与 sales 身份各创建一条客户(`customer.created`),tenant2-admin 在
  tenant2 造一条,从而:① 行哈希真实、chain/verify 才有意义;② 同时具备
  "不同 actor"(测 own)与"不同租户"(测隔离)的数据。不直接手插业务事件,
  避免与真实写入路径口径漂移。

### 6.2 集成测试用例

**列表 / 详情 / 过滤**

- 列表 happy path:admin(all)`GET /api/audit-logs` → 仅本租户事件、
  `{ data,page,pageSize,total }` 形状、`created_at DESC, id DESC`、`actorName`
  对 tenant_user 行解析出姓名。
- 过滤:分别按 `action` / `actorId` / `actorType` / `resourceType` /
  `resourceId` / `requestId` / `from`-`to` 过滤,返回正确子集;验证
  "时间窗缩窄 + action 应用过滤"路径正确(§3.2)。
- 详情:`GET /api/audit-logs/:id` 返回单条含 `before/after/metadata/reason/
  ipAddress/userAgent`。

**dataScope**

- own:sales(own)列表只见 `actor_id = 自己` 的事件,看不到 admin 的事件;
  getOne 一条 admin 发起的事件 id → **404**(不透明)。
- all:admin 列表见全租户事件(含 sales 发起的)。

**跨租户隔离**

- tenant2-admin 列表不含 tenant1 事件;tenant1-admin getOne 一条 tenant2 事件
  id → **404**;过滤参数无法跨租户取数。

**RBAC**

- 无 token → **401**;`TEST_USER4`(无 `audit_logs:view`)对 list / getOne /
  chain-verify → **403**;并断言该 403 命中既有 PermissionGuard 的
  `rbac:permission_denied` 留痕(读后链中新增该事件)。

**链校验**

- `GET /api/audit-logs/chain/verify`:admin 调用 → `{ ok:true, total:N }`,
  `total` 与直接调 `verifyChain('tenant:'+tenantId)` 一致。
- **chain_key 不可越权**:端点无 chain_key 入参;附带多余 query(如
  `?chain_key=platform`)被 whitelist 丢弃 / 不生效,仍只校验本租户链。
- **路由顺序**:`/api/audit-logs/chain/verify` 解析到校验端点,**不**被
  `:id` 当作 `id='chain'`(断言不返回 400/404 误解析)。
- **篡改→FAIL**:经 superuser/admin 连接(绕 RLS;但 022 触发器禁 UPDATE/DELETE,
  故用 **INSERT 一条 prev_hash/row_hash 蓄意错误的行**破链,而非改既有行)后,
  端点返回 `{ ok:false, failedAt:{ id, reason } }`,证明状态条能反映真实破损。

**只读 / 精度**

- 读不写审计:一次 list / getOne **不**向链新增事件(计数稳定;唯一例外是上面
  的 403 `permission_denied`)。
- 模块无任何写路由(create/update/delete 一律不存在,404/405)。
- bigint:响应 `id` 为 string,大 id 不丢精度;以该 string 调 getOne 精确命中。

### 6.3 单元测试(轻量)

- mapper:行 → summary/detail 塑形,确认 `row_hash`/`prev_hash`/`hash_version`
  **不**出现在输出,`id` 为 string,`actorName` 缺失时为 null。
- chain_key 派生:由 tenantId 拼 `tenant:<id>` 的纯函数 / 服务方法,确认绝不
  采纳外部输入。

### 6.4 前端浏览器 QA(Playwright + 真实 Chromium)

复用 1H QA 方式(两 dev server 真起,经 Vite 代理),截图留证:

- 登录 → `/audit-logs`:顶部「审计链完整 ✓ 共 N 条」绿条;列表渲染(时间 /
  操作者 / 动作 / 资源);过滤(改时间窗 / 选 actorType / 填 action)生效。
- 点击一行 → 详情面板展示 before/after 字段级 diff + metadata/reason。
- 无 `audit_logs:view` 用户 → 整页「没有权限查看审计日志」(403 优雅降级)。
- 导航「审计」链接可达;路由正确。
- 隐私 spot-check:grep 页面源确认零 `console.*` / 零 localStorage/sessionStorage /
  零 URL 写入,审计内容只在 React 状态。

### 6.5 质量门槛

- `pnpm verify` 全绿:lint / format / typecheck / build / unit / **integration
  (在现有基础上 + 本阶段 audit 用例)** / security 13。
- 安全回归脚本无需新增项即已覆盖 append-only(022/023 断言);可选追加一条静态
  检查:audit 模块不含任何写路由 / 不引用 `AuditService`(只用只读
  `AuditQueryService`),作为"只读"的护栏。

## 7. 风险与回滚

本阶段是**零 migration、纯只读、纯加法**的模块,整体风险等级低;主要风险集中在
"新开了一个看最敏感元数据的窗口"——隔离与泄漏面要看牢,性能是次要关注。

### 7.1 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| `audit_log_chains` 无 RLS,若有人日后给 verify 端点加 `chain_key` 入参,即可越权校验 / 探测他人链 | 中 | 端点签名**不含** chain_key,只由服务端按已认证 tenantId 派生(§2.2/§4.1.2);单元 + 集成测试钉死"外部 chain_key 不生效";code review 红线。 |
| **泄漏面扩大**:`before/after/metadata` 是各写入方自填的快照,查看器把它从"仅 DBA 可见"提升为"持权用户产品内可见";若历史某写入方误记了敏感明文,现在会被看到 | 中 | 依赖既有写入方已遵循的"只记标识与摘要、不记密码 / 业务明文"约定;查看器不二次加工、不外发;按 `audit_logs:view` 收口 + dataScope;**后续项**:抽查现存 before/after 是否有越界字段,发现则在源头(写入方)修正,而非在查看器打补丁。 |
| dataScope `own` 语义实现错(WHERE 漏加 `actor_id = caller`)导致 own 用户看到全租户审计 | 中 | own 锚定到 `actor_id`(§4.1.4)集中在 `AuditQueryService` 一处下推;集成测试专测 own 只见自己、getOne 他人事件 404。 |
| 链校验 `verifyChain` 为 O(n) 全链重算,链很长时响应慢 / 占资源(软 DoS 面) | 低-中 | 本阶段接受按需整链校验(规模可控);若变热,可单独限流 / 加超时 /（后续)做增量或缓存校验,而不影响 list 端点。 |
| 列表 `COUNT(*) + OFFSET` 在持续增长的 append-only 表上随数据量变慢 | 低 | 默认 7 天时间窗 + `(tenant_id, created_at)` 复合索引先缩窄;游标(按 id)分页留作后续优化。 |
| `action` 无单列索引,大时间窗 + action 过滤偏慢 | 低 | 先用时间窗索引缩窄再过滤(§3.2);**不为此加索引**(避免引 migration),留后续。 |
| 路由 `/chain/verify` 被 `:id` 误解析为 `id='chain'` | 低 | 静态路由声明在 `:id` 之前 /（或）`:id` 限定数字;集成测试断言不误解析。 |
| `id` 为 bigint,JS number 精度丢失会取错行 | 低 | 全链路以 string 传递(§3.3/§4.1.5);集成测试断言大 id 精确命中。 |
| "谁查看了审计日志"本阶段无留痕(治理缺口) | 低(已知取舍) | 本阶段读不审计(§3.5/§4.2);被拒访问已有 `rbac:permission_denied` 留痕;`audit.viewed` 留作后续子阶段。 |
| 误把链内部(`row_hash`/`prev_hash`)暴露给 UI / 响应 | 低 | 默认不进响应、不在页面呈现(§3.3/§5.4);链可信度只经聚合校验状态条传达。 |

### 7.2 回滚方案

- **回滚=纯代码回退**:本阶段不含任何 migration、不改产品 seed、不改
  `audit_logs` / `audit_log_chains` 结构与既有数据,因此回滚是最安全的一类——
  `git revert` 相关提交即可,**无任何数据库状态需要反向迁移 / 对账**。
- **回退面**(都为新增 / 注册,删除即净移除,不留悬挂):
  - 后端:`AuditQueryService` + `@Controller('api/audit-logs')` + DTO/mapper,
    及其在模块 `controllers/providers` 的注册;
  - 前端:`apps/web/src/audit/AuditLogsPage.tsx`、`App.tsx` 路由、`AppLayout`
    导航链接、`api-client` 三个方法 + `lib/types` 新类型;
  - 测试夹具:`SEED_PERMS` 里新增的 `audit_logs:view` 授权及 audit 测试文件。
- **下线粒度**:若仅链校验端点出问题(如性能),可单独摘除 `/chain/verify`
  路由而保留 list / detail——三端点彼此独立,无耦合状态。
- **不可篡改性不受回滚影响**:查看器从不写审计 / 不改链;无论装上还是回退,
  既有 `audit_logs` 数据、哈希链与 append-only 约束(022/023)原样不动,
  `pnpm db:verify-chain` 结论不因本模块的存废而变化。

## 8. 验证命令与验收标准

### 8.1 验证命令

**完整质量门槛(提交前置)**

```bash
pnpm verify          # lint + format:check + typecheck + build + unit + integration + security 13
```

**分步 / 定向(开发中)**

```bash
# 仅本模块集成测试(快速回归)
pnpm --filter @kirindesk/api test:integration -- audit

# 自动修格式(本仓约定:静默修,绿了再报告)
npx prettier --write "apps/api/src/audit/**/*.ts" "apps/web/src/audit/**/*.tsx"

# 前端类型 + 构建
pnpm --filter @kirindesk/web build
```

**链校验口径一致性(端点 vs CLI 必须逐字节一致)**

```bash
# CLI 直校本租户链;与 GET /api/audit-logs/chain/verify 的 { ok,total } 对照
pnpm db:verify-chain tenant:00000000-0000-0000-0000-000000000001
```

**本地冒烟(dev server 起在 :3001,用 dev 租户)**

```bash
TOK=$(curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"dev-password-123","tenantSlug":"dev-tenant"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/audit-logs?pageSize=5"          # 列表
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/audit-logs/chain/verify"        # 链校验 PASS
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/audit-logs/<id>"                # 详情
curl -s -o /dev/null -w '%{http_code}' "localhost:3001/api/audit-logs"                      # 无 token → 401
```

**前端浏览器 QA**:Playwright 跑 §6.4 脚本,产出截图(链状态条 / 列表 + 过滤 /
详情 diff / 403 降级 / 导航),并 grep 页面源做隐私 spot-check。

### 8.2 验收标准(全部满足方算完成)

**后端**

- [ ] `GET /api/audit-logs`、`/:id`、`/chain/verify` 三端点存在,均 `audit_logs:view`
      守卫;无 token → 401,无该权限 → 403,跨租户 / 不存在 → 不透明 404。
- [ ] 租户隔离生效:仅见本租户事件;过滤 / id 无法跨租户取数。
- [ ] dataScope:`all` 见全租户;`own` 仅见 `actor_id = caller`(getOne 他人事件 404)。
- [ ] `chain_key` 只由服务端按已认证 tenantId 派生;端点不收外部 chain_key;
      `/chain/verify` 不被 `:id` 误解析。
- [ ] 链校验端点 `{ ok,total }` 与 `pnpm db:verify-chain tenant:<id>` **逐字节一致**;
      构造破链行后端点返回 `ok:false` + `failedAt`。
- [ ] **只读**:无任何写路由;一次 list / getOne 不向链新增事件(除被拒访问的
      既有 `rbac:permission_denied` 留痕)。
- [ ] mapper 不输出 `row_hash`/`prev_hash`/`hash_version`;`id` 为 string;
      `actorName` 对 tenant_user 解析、否则 null。
- [ ] **零 migration、零产品 seed 改动**;`AuditService` / 哈希算法 / 链结构 /
      append-only 约束一字未动。

**测试与门槛**

- [ ] `pnpm verify` 全绿:含本阶段新增 audit 集成用例(§6.2)+ 轻量单元(§6.3);
      security 13/13。
- [ ] (可选)安全回归追加"audit 模块无写路由 / 不引用 `AuditService`"静态检查通过。

**前端**

- [ ] `/audit-logs` 页:顶部审计链完整性状态条(PASS 绿 + 计数 / FAIL 红 + 失败点)、
      列表(时间 / 操作者 / 动作 / 资源)+ 过滤(默认 7 天窗)+ 分页、行内详情
      before/after 字段级 diff。
- [ ] 无 `audit_logs:view` 用户 → 整页 403 优雅降级;导航「审计」链接可达。
- [ ] 浏览器 QA 截图齐全且功能正常;隐私 spot-check:零 `console.*`、零
      localStorage/sessionStorage、零 URL 写入,审计内容只在 React 状态。

**流程(CLAUDE.md §1/§9)**

- [ ] 实施前本规划(§1–§8)经用户确认;实施按节推进,不擅自扩面。
- [ ] 完成后按 §9 报告:新增 / 修改 / 删除文件、执行命令、测试结果(通过 / 失败)、
      是否动 schema(否)、是否产生 secret(否)、遗留风险、建议下一步。

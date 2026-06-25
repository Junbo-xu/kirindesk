# Phase 1J 规划 — 数据导出(Data Export:Reports + Audit)

在既有只读查询服务之上,补一层**按当前查询条件导出**的能力:把报表汇总
(Phase 1F-D)与审计日志(Phase 1I)从「页面内可见」延伸到「可下载、可离线
留存」。复用既有聚合 / 列表查询、RBAC、dataScope、RLS 与审计设施,**只读消费 +
落一份审计**,不新建业务表、不改既有查询语义。本文档为 Phase 1J 的完整规划
(§1–§9),经用户确认后再按节实施。

## 1. 目标与范围

### 1.1 背景与目标

KirinDesk 的信任承诺里,「可导出 / exportable」与「可审计 / auditable」是并列
写进 CLAUDE.md §3 的对外措辞:客户数据属于客户,客户应当能把自己的数据**带走**。
到目前为止:

- **报表**(Phase 1F-D):`GET /api/reports/sales-summary` /
  `/purchase-summary` 已能按口径 / 分组 / 时间窗在本位币下聚合,但结果只在
  `/reports` 页面内呈现,1F-D 明确**「export deferred」**(导出留待后续)。
- **审计日志**(Phase 1I):`GET /api/audit-logs` 已能按维度检索、查看
  before/after 明细并校验链完整性,但 1I §1.3 同样把 **CSV/Excel 导出**显式
  推到「Phase 1I 之后的『数据导出』模块」。

也就是说,两个最该被「带走」的只读视图——给老板看的经营汇总、给合规 / 财务看的
操作留痕——都已经建好查询、却**不可下载**。用户想把一段时间的销售汇总发给会计、
把一段审计事件存档备查,目前只能截图或手抄。这正是本阶段要补的半成品收尾:把
**已有的、已经过 RBAC/dataScope/RLS 收口的查询结果**,以标准表格文件的形式
导出。

本阶段目标:为持有相应查看权限的租户用户,提供**与页面所见一致**(同样的过滤
条件、同样的 dataScope 可见范围、同样的本位币口径)的数据导出——报表汇总与审计
日志各一条导出路径,产出可被 Excel / 表格软件直接打开的文件;且导出作为
CLAUDE.md §6 列明的**敏感操作**,每次都写入审计留痕(谁、在何时、导出了什么范围、
多少行)。

### 1.2 本阶段要做(范围内)

- **后端导出端点**(复用既有只读服务,不新写聚合 / 列表 SQL):
  - **报表导出**:在既有 `ReportsService` 之上,按与
    `sales-summary` / `purchase-summary` **完全相同的入参**(from/to、groupBy、
    granularity、caliber)产出导出文件;数值口径、未计入(un-costed)计数、
    本位币与页面一字不差。权限沿用 `reports:view`。
  - **审计导出**:在既有 `AuditQueryService` 之上,按与
    `GET /api/audit-logs` **相同的过滤集**(from/to、actor、action、resource、
    requestId)产出导出文件;dataScope(all 看全租户、own 仅自己发起)与列表
    一致。权限沿用 `audit_logs:view`。导出**列**与列表口径一致——只出标识与
    摘要,**不导出 before/after/metadata 等可能含业务明文的快照**,也绝不导出
    哈希链内部字段(详见 §范围外与后续章节)。
- **导出格式**:以 **CSV(UTF-8,Excel 可直接打开)为本阶段基线格式**(最简、
  零三方依赖、可调试);是否同时产出真正的 `.xlsx`、用哪种生成方式,作为格式
  决策留到 §「导出格式与编码」逐项钉死(倾向先 CSV、Excel 视依赖与收益再定),
  避免在 §1 过早承诺实现细节。
- **导出审计(本阶段与 1I 的关键差异)**:导出是 CLAUDE.md §6 明列的敏感操作,
  **每次导出都经既有 `AuditService` 写一条审计事件**(记录导出类型、过滤条件
  摘要、返回行数等标识与摘要;不记业务明文),区别于 1I「读不审计」的约定——
  「带走数据」比「看一眼」需要更强的留痕。具体 action 命名与 metadata 形状在
  §「安全护栏与审计」钉死。
- **前端导出入口**:在既有 `/reports` 与 `/audit-logs` 页面,基于**当前已应用的
  过滤条件**加一个「导出」按钮,点击即按当前条件下载文件;无相应权限时按钮 /
  请求走既有服务端 403 优雅降级约定(UI 隐藏不是边界,§4)。纯加法,不改既有
  页面的查询与展示逻辑。

### 1.3 本阶段不做(范围外)

- **不改既有查询语义 / 不新写聚合**:导出严格复用 `ReportsService` /
  `AuditQueryService` 的现有口径与过滤;不为导出引入新的聚合维度、新的过滤字段
  或不同的 dataScope 语义。导出 = 既有只读结果的**另一种序列化**。
- **零 migration、零新权限码**:不新建任何表 / 列 / 索引;导出沿用既有
  `reports:view` 与 `audit_logs:view`(是否需要独立的 `*:export` 细分权限,作为
  §「安全护栏与审计」的待确认项评估,默认**先不拆**、复用既有 view 权限以保持
  最简)。
- **不导出敏感明细**:审计导出**不含** before_json / after_json / metadata_json
  (各模块自填快照,可能含业务明文)与 row_hash / prev_hash / hash_version
  (链内部);只导出与列表一致的标识 + 摘要列。报表导出只含聚合行,本就不涉及
  逐单明文。
- **不做计划任务 / 定时导出 / 邮件投递 / 异步大任务队列**:本阶段只做**同步、
  按需、单次**的下载;超大结果集的流式 / 分片 / 后台任务化作为后续优化项,在
  §「风险与回滚」记其边界,不在本阶段实现。
- **不做导入(import)/ 回填 / 模板**:只做单向导出,不接受上传解析。
- **不做平台侧(platform-admin)跨租户导出**:与 1I 一致,仅**租户内**自助导出;
  平台侧另有授权 / 审计要求(CLAUDE.md §3),不在本阶段。
- **不做对象存储落盘 / 长期留存导出文件**:导出即时生成、直接响应给浏览器下载,
  服务端不持久化导出产物(避免新增需要清理 / 鉴权的文件资产);与 Phase 1E 的
  文件模块解耦。

### 1.4 与既有查询服务 / RBAC / 审计的关系

本阶段是既有只读链路的**序列化出口**,严格复用、绝不修改其判定:

- **数据源 = 既有只读服务**:报表导出调用 `ReportsService`(同一聚合 SQL、同一
  dataScope 下推、同一本位币与口径);审计导出调用 `AuditQueryService`(同一
  WHERE、同一 dataScope、同一 RLS 上下文)。**导出与页面共用同一条查询路径**,
  从源头保证「导出所得 = 页面所见」,不会出现两套口径漂移。
- **隔离与可见范围不被放大**:导出经 `withTenantContext` + 既有 RLS / dataScope,
  绝不能导出调用者在页面上看不到的行;own-scoped 调用者导出的审计只含自己发起的
  事件,报表只覆盖自己的订单。导出**不放大**任何泄漏面。
- **导出是被审计的敏感操作**:沿用既有 `AuditService.writeToChain`(不改哈希
  算法 / 链结构),把导出动作写入同一条不可篡改审计链——这与 1I 查看器形成闭环:
  既能查看留痕,「导出数据」本身也留痕、且能在审计查看器里被看到。
- **净增**:仅新增「把既有查询结果序列化为 CSV/Excel + 写一条导出审计 + 前端
  下载入口」的代码;不触碰 schema、聚合、列表查询、密钥、provider。与 1I / 1H
  同构,属低风险纯加法小步。

## 2. 数据模型与依赖

本阶段**零 migration**:不需要任何新表 / 新列 / 新索引——导出所需的数据全部来自
两个既有只读服务的现成输出。本节逐项说明导出的取数来源与形状、全量取数相对分页
列表的差异与行数上限,以及唯一可能引入的外部依赖(Excel 生成库)的评估。

### 2.1 零新表、零新列、零新索引(纯复用既有读路径)

- 报表导出读 `sales_orders` / `purchase_orders` + `tenant_settings`(本位币),
  **经既有 `ReportsService` 聚合**——与 `/api/reports/*` 同一条 SQL、同一索引
  (`idx_*_tenant_created` 等),不新增聚合维度,因此无需新索引。
- 审计导出读 `audit_logs`,**经既有 `AuditQueryService` 的同一 WHERE 构造**——
  默认走 `idx_audit_logs_tenant_created (tenant_id, created_at)`(7 天默认窗 +
  过滤),同 1I §2.3,不新增索引。
- 两张审计表(`audit_logs` / `audit_log_chains`)的 append-only 约束、RLS、触发器
  一律不动;导出只读,且导出动作本身经既有 `AuditService` **写一条**新审计事件
  (§1.2),不改写入路径与哈希算法。

### 2.2 报表导出的数据来源与形状(ReportsService → ReportSummary)

报表导出**直接复用** `ReportsService.salesSummary(actor, query)` /
`purchaseSummary(actor, query)` 的返回对象 `ReportSummary`,序列化为表格,不重算:

```
ReportSummary {
  caliber, currency, groupBy,
  range: { from, to, granularity },
  rows:   ReportRow[]   // { key, label, orderCount, amountBase, unCostedCount }
  totals: { orderCount, amountBase, unCostedCount }
}
```

导出文件的**数据行**与列(实际表头文案在 §4 钉死):

| 列 | 来源 | 说明 |
|---|---|---|
| 分组 | `row.label` | `ReportsService` 已把状态映射为中文、实体映射为公司名、周期映射为桶字符串(`labelFor`),导出**原样取 label**,不二次映射。 |
| 订单数 | `row.orderCount` | 整数。 |
| 本位币金额 | `row.amountBase` | 已是 `numeric(18,2)` 的十进制字符串(`ReportsService` 以 BigInt 整数分求和后格式化),**导出层不做浮点运算**,直接落字符串;金额单位 = `summary.currency`(进文件头/列名,§4 定)。 |
| 未计入 | `row.unCostedCount` | 该分组内 `total_amount_base IS NULL`(未计汇率)的订单数。 |

- **合计行**:复用 `summary.totals`(同口径整数分汇总),作为文件末行 / 单独区
  (§4 定),与页面 tfoot 一字不差。
- **口径元信息**:`caliber` / `currency` / `range`(from/to/granularity)/
  `groupBy` 作为文件的说明性前置信息(preamble 或文件名),让离线文件自带「这是
  什么口径、哪段时间、什么币种」的上下文;**是否以及如何写入** preamble 在 §4 定。
- **天然有界**:聚合结果按「不同分组」产生行(状态≈7 行、周期≈窗口内月/日数、
  客户/供应商≈实体数),规模可控,**报表导出无需行数上限**(§2.4 的 cap 只针对
  审计明细导出)。

### 2.3 审计导出的数据来源与形状(AuditQueryService → 列表行)

审计导出**复用 `AuditQueryService` 的列表查询口径**(同一 dataScope 下推、同一
`actorName` 的 tenant-safe `LEFT JOIN users`、同一 RLS 上下文),导出的**列与
列表 summary 严格一致**:

| 列 | 来源(`AuditLogSummary`) | 说明 |
|---|---|---|
| 时间 | `createdAt` | 事件时间(timestamptz);文件内格式(本地化 vs ISO)§4 定。 |
| 操作者 | `actorName ?? actorId` | `tenant_user` 解析出姓名,否则回退 id(同列表)。 |
| 操作者类型 | `actorType` | tenant_user / platform_admin / system。 |
| 动作 | `action` | 如 `user.created`。 |
| 资源类型 | `resourceType` | 如 user / role / file。 |
| 资源 ID | `resourceId` | 可空。 |
| 事件 ID | `id` | bigint **以字符串导出**(同 1I,避免精度丢失)。 |

- **绝不导出的列(最小泄漏面,§1.3)**:`before_json` / `after_json` /
  `metadata_json`(各模块自填快照,可能含业务明文)、`reason` / `ip_address` /
  `user_agent`(详情专属)、`request_id`(1I 已定为详情专属、不在列表 summary)、
  以及 `row_hash` / `prev_hash` / `hash_version`(链内部)。**导出 ⊆ 列表所见**,
  不因「换了个序列化出口」就把详情字段或链内部带出去。(若将来确有「带
  before/after 的合规取证导出」需求,属更敏感的单独子阶段,需另行授权 + 审计
  设计,不在本阶段。)
- **逐行真实数据**:行来自既有 `audit_logs`,无需回填 / 加工。

### 2.4 全量导出 vs 分页:取数方式与行数上限

- **报表**:`ReportsService` 本就一次性返回全部分组(无分页),导出**直接整体
  序列化**,无额外取数问题。
- **审计**:`AuditQueryService.list` 是 `offset + COUNT` **分页**(默认 pageSize
  20、上限 100),而导出要的是「**当前过滤条件下的全部匹配行**」。为避免 N 次翻页
  往返,导出**新增一个只读服务方法**(如 `AuditQueryService.listForExport(actor,
  query, cap)`),**复用同一个 WHERE 构造器**,以单条 `SELECT … ORDER BY
  created_at DESC, id DESC LIMIT $cap`(无 offset)取数;`cap` 是服务端固定的
  **行数上限**(具体值 §3/§5 定,量级如 1 万–5 万),用于护住内存与软-DoS 面。
  - **不静默截断**:命中 cap 时,导出需**显式告知**已截断(文件内标注 + 导出
    审计 metadata 记 `truncated:true` + 返回行数),遵循 1I「no silent caps」与
    CLAUDE.md §9;由用户收窄时间窗 / 过滤后重导,而非以为「全了」。
  - 导出走服务方法、**不经 HTTP 列表 DTO 的 `@Max(100)`**(那是分页 UI 约束,
    不是导出语义);上限改由导出自己的 `cap` 表达,二者互不影响。
  - append-only 表持续增长,`cap + 默认 7 天窗`是本阶段的最简护栏;游标 / 流式 /
    后台任务化的大导出留作后续(§8 记边界)。

### 2.5 依赖评估(CSV 零依赖基线 / Excel 是否引库)

CLAUDE.md §2「最简先行、偏好无聊可调试方案」直接决定本节取舍:

- **CSV(本阶段基线,零运行时依赖)**:在 `apps/api` 内手写一个极小的 CSV
  序列化器即可——逗号 / 引号 / 换行的转义、UTF-8 **BOM**(让 Excel 正确识别中文
  编码)、以及**公式注入防护**(对以 `= + - @`、Tab、CR 开头的单元格做中和,
  详于 §4/§5)。**不引任何三方库**,实现完全可读可测。「CSV 能被 Excel 直接
  打开」已覆盖「Excel 导出」诉求的绝大部分。
- **真正的 `.xlsx`(可选,需评估依赖)**:若确需原生 Excel(多 sheet / 样式 /
  数字格式),才需引库。候选:
  - `exceljs`(纯 JS、流式 writer、MIT、生态成熟,体积偏大);
  - SheetJS `xlsx`(npm 社区版与官方 CDN 版进度不一,历史上有过原型污染 / ReDoS
    类告警,引入需盯版本与来源)。
  倾向:**本阶段先只做 CSV**,把 `.xlsx` 与「选哪个库 + 固定版本 + 供应链审查」
  一并留到 §4「导出格式与编码」逐项裁决(若引,优先 `exceljs` + pin 版本)。
  在 §4 拍板前,**不在代码里引入任何 Excel 库**。
- **无新增基础设施依赖**:导出是**同步、请求内即时生成、直接流式响应下载**,
  不持久化产物(§1.3),因此**不**新增对象存储 / 队列 / 定时器 / 邮件等依赖,
  也不触碰 Phase 1E 文件模块。

### 2.6 不需要的变更

- 无新表、新列、新索引、新约束、新 RLS policy → **无 migration**。
- 无新权限码(默认复用 `reports:view` / `audit_logs:view`;是否细分 `*:export`
  留 §5 评估,默认不拆)。
- 不改 `ReportsService` / `AuditQueryService` 的既有聚合 / 列表语义、不改
  dataScope 口径;审计导出仅**新增**一个复用同一 WHERE 的只读 `listForExport`
  方法,不动既有 `list` / `getOne` / `verifyTenantChain`。
- 不改 `AuditService` / 哈希算法 / 链结构 / append-only 约束;导出审计经其既有
  `log()` 写入,与各业务模块写审计同路。
- CSV 基线**零三方依赖**;Excel 库的引入(若有)是 §4 的显式决策,默认不引。

## 3. 后端 API 端点

导出端点是既有只读端点的**「同口径、换序列化、加一条审计」**版本:挂在既有
`reports` / `audit-logs` 控制器下,沿用既有 `TenantAuthGuard + PermissionGuard`、
既有权限码、既有 DTO 校验与 dataScope/RLS,**不新写聚合 / 列表 SQL**。与 reports/
audit 只读端点的唯一行为差异是:① 返回文件流而非 JSON;② 成功导出**写一条
审计**(§1.2/§6,命名详见 §5)。

### 3.1 端点一览

| 方法 & 路由 | 权限 | 复用的查询 | 说明 |
|---|---|---|---|
| `GET /api/reports/sales-summary/export` | `reports:view` | `ReportsService.salesSummary` | 与 `sales-summary` **完全相同的入参**,导出销售汇总(分组行 + 合计)CSV。 |
| `GET /api/reports/purchase-summary/export` | `reports:view` | `ReportsService.purchaseSummary` | 同上,采购汇总。 |
| `GET /api/audit-logs/export` | `audit_logs:view` | `AuditQueryService.listForExport`(§2.4 新增只读方法) | 与 `GET /api/audit-logs` **相同的过滤集**,导出审计明细 CSV(全量,至多 `cap` 行)。 |

- **方法用 GET**:与既有只读端点同构,前端可用同一 `request`/fetch(带 Bearer)
  取流。导出虽写一条审计,但那是 append-only 的**旁路留痕**,非业务数据变更,
  GET 触发可接受;响应置 `Cache-Control: no-store`,且前端走 fetch+blob(非
  导航,不会被预取/缓存放大)。
- **路由顺序(audit)**:静态 `export` 声明在 `:id(\d+)` 之前;且 `:id` 已限定为
  数字,`export` 不会被误解析为 id(同 1I 的 `chain/verify` 处理)。
- **不另立权限码**:三个端点分别复用 `reports:view` / `audit_logs:view`;是否细分
  `reports:export` / `audit_logs:export` 留 §5 评估,默认**不拆**(最简,与 §2.6
  一致)。

### 3.2 入参 DTO 与复用既有口径

走全局 `ValidationPipe`(whitelist + forbidNonWhitelisted + transform),**复用既有
查询字段的校验**,仅追加一个 `format`:

- **报表导出** `ReportSummaryExportQuery extends ReportSummaryQuery`:原样继承
  `from` / `to`(`@IsISO8601`)、`groupBy` / `granularity` / `caliber`
  (`@IsIn`),**口径校验也复用**——调用同一个 `salesSummary`/`purchaseSummary`,
  因此「sales 拒 supplier 分组、purchase 拒 customer 分组」「from ≤ to」等既有
  校验自动生效,导出与页面口径不可能漂移。追加 `format?`。
- **审计导出** `AuditExportQuery`:携带与 `ListAuditLogsQuery` **相同的过滤字段**
  (`from`/`to`、`actorId`(任意版本 `@IsUUID`)、`actorType`(白名单)、`action`/
  `resourceType`/`resourceId`/`requestId`(`@IsString @MaxLength`)),但**不含
  `page`/`pageSize`**——导出是「当前过滤下的全量(至 `cap`)」,分页对导出无意义,
  省去后由 forbidNonWhitelisted 拒收。追加 `format?`。过滤字段的 validator 与
  `ListAuditLogsQuery` 共享(抽公共基类或等价声明,实施时定),保证导出与列表
  过滤一字不差。
- **`format?`**:`@IsOptional @IsIn(['csv'])`,默认 `csv`。本阶段**只接受 `csv`**;
  `xlsx` 在 §4 拍板前一律由 `@IsIn` 拒为 400(不静默降级),拍板后再放开取值。
- **所有过滤值参数化下推**(防注入),与既有服务一致;导出层不拼 SQL,只把
  DTO 透传给被复用的查询服务。

### 3.3 响应:文件流与下载头

- **Content-Type**:`text/csv; charset=utf-8`(csv);响应体前置 UTF-8 **BOM**,
  让 Excel 正确识别中文(§2.5)。
- **Content-Disposition**:`attachment; filename="<scheme>.csv"` + RFC 5987 的
  `filename*=UTF-8''…`(中文/非 ASCII 文件名安全)。文件名编码导出类型 + 时间窗
  (+ 报表的 caliber/groupBy)+ 服务端时间戳;**具体命名方案 §4 钉死**。
- **Cache-Control**:`no-store`(已授权的导出不应被中间层缓存)。
- **传输方式**:CSV 在内存内构建(规模受 §2.4 的 `cap` / 报表分组天然有界约束),
  以 Nest `StreamableFile` / `@Res()` 直出;超大结果集的流式分块留作后续(§8)。
- **截断标记(audit)**:命中 `cap` 时仍返回 200 + 已截断的行,但**显式标注**
  (文件内尾注 + 导出审计 metadata `truncated:true` + 实际行数),绝不静默截断
  (§2.4 / CLAUDE.md §9)。
- **错误**:无权 → 403(PermissionGuard,且已被既有 `rbac:permission_denied`
  留痕);入参非法 → 400;跨租户 / 越权由 RLS+dataScope 在查询层兜底(导出无
  `:id` 端点,不涉及不透明 404,越权过滤只会得到更少/零行)。

### 3.4 权限码与 dataScope

- **权限码(复用)**:`reports:view`(报表导出)、`audit_logs:view`(审计导出),
  均已 seed,无新码。三个端点用 `@RequirePermission(...)` + PermissionGuard 服务端
  强制;前端「导出」按钮的显隐只是体验,**不是边界**——无权用户直连导出端点同样
  403。
- **dataScope(复用,不重写)**:导出**复用被调用查询服务里已有的 dataScope
  下推**——`all` 导全租户;`own` 报表仅 `owner_user_id = caller`、`own` 审计仅
  `actor_id = caller`(§1.4/§2.3)。导出**不可能**导出调用者在页面上看不到的行。
- **租户隔离**:三端点经 `withTenantContext` + 既有 RLS,别租户行天然不可见。

### 3.5 导出即审计(端点侧行为)

- 每次**成功**导出,经既有 `AuditService.log()` 写**一条**审计事件到同一条
  不可篡改链(与各业务模块写审计同路,不改哈希/链结构)。
- 记录**标识 + 摘要**:导出类型(sales/purchase/audit)、`format`、过滤条件摘要
  (报表:from/to/caliber/groupBy/granularity;审计:from/to/actor/action/
  resource 等)、返回行数、`truncated` 标记;**不记业务明文、不记被导出的逐行
  内容**。
- 具体 **action 命名**(如 `report.exported` / `audit_logs.exported`)、
  `resource_type` 与 metadata 字段形状在 §5「安全护栏与审计」钉死;§3 只确立
  「导出必写一条审计」这一端点行为(区别于 1I「读不审计」)。
- 失败导出是否补一条失败审计,留 §5 评估(默认成功才记)。

### 3.6 服务层(复用既有查询 + 新增导出编排)

不改既有查询服务的读语义,只新增**编排 + 序列化**:

- **CSV 序列化器**(如 `apps/api/src/common/export-csv.ts`):纯函数、零依赖,
  负责 RFC 4180 转义 + BOM + 公式注入中和(细节 §4/§5),报表与审计共用。
- **报表**:新增 `ReportsExportService`(挂在既有 `ReportsModule`,注入既有
  `ReportsService` + `AuditService`——该模块已 import `AuditModule`):
  `exportSummary(side, actor, query)` 调既有 `salesSummary`/`purchaseSummary`
  取 `ReportSummary` → 行+合计转 CSV → 写导出审计 → 返回 `{ filename, mime,
  body }`。`ReportsService` **一字不改**。
- **审计**:在 `AuditQueryService` 新增只读 `listForExport(actor, query, cap)`
  ——**复用同一个 WHERE 构造**(把现有 `list` 的条件拼装抽成共享私有方法,
  `list` 行为不变),以单条 `… ORDER BY created_at DESC, id DESC LIMIT $cap`
  取全量;新增 `AuditExportService`(挂在既有 `AuditViewerModule`,注入
  `AuditQueryService` + `AuditService`——该模块已 import `AuditModule`)做
  `listForExport → CSV → 写导出审计 → 返回文件`。`list`/`getOne`/
  `verifyTenantChain` **不动**。
- **`cap` 常量**服务端固定(量级 §2.4,确值 §5),不由客户端传入。

### 3.7 不做的端点

- 无 `xlsx` 端点 / 取值(§4 拍板前 `format` 只认 `csv`)。
- 无异步 / 后台任务 / 定时 / 邮件投递导出端点(本阶段仅同步按需,§1.3)。
- 无平台侧跨租户导出端点(仅租户内,§1.3)。
- 无「带 before/after/metadata 的逐行取证导出」端点(更敏感,另立子阶段,§2.3)。
- 无导入(import)端点。
- 无「把导出落对象存储 / 返回下载令牌」的端点(导出即时直出、不持久化,§1.3)。

## 4. 导出格式与编码(CSV / Excel)

本节把 §2.5 / §3 推到这里的格式问题逐项**钉死**:本阶段交付**仅 CSV**(UTF-8 +
BOM,Excel 可直接打开),原生 `.xlsx` 明确**不在 1J 实现**(决策与后续路径见
§4.7);并固定 CSV 的转义、注入防护、列 / 表头 / 元信息、文件名与字段字符串化口径,
使「导出所得」既能被表格软件正确打开,又与页面口径一字不差。

### 4.1 格式裁决:本阶段只做 CSV,不引 Excel 库

- **交付格式 = CSV**。理由(CLAUDE.md §2 最简先行):CSV 零运行时依赖、完全可读
  可测;且「CSV 能被 Excel / WPS / Numbers 直接打开」已满足「Excel 导出」诉求的
  绝大部分。`format` 入参本阶段**只认 `csv`**(§3.2 的 `@IsIn(['csv'])`),传
  `xlsx` 一律 400,**不静默降级**。
- **不引入任何 Excel 第三方库**(`exceljs` / SheetJS `xlsx` 均不引),避免无收益
  的供应链 + 维护成本。原生 `.xlsx` 作为后续可选项,路径记于 §4.7。

### 4.2 CSV 编码与转义(RFC 4180,Excel 友好)

- **UTF-8 + 前置 BOM**(`EF BB BF`):Windows Excel 默认按本地代码页解析无 BOM 的
  CSV,会把中文显示为乱码;前置 BOM 让其正确识别 UTF-8。
- **转义(RFC 4180)**:字段含**逗号 / 双引号 / CR / LF** 时,整字段用双引号包裹,
  字段内的双引号**翻倍**(`"` → `""`)。其余字段不加引号。
- **行结束符 CRLF(`\r\n`)**:RFC 4180 规范、Excel 最稳。
- **空值 = 空字段**:`null` / `undefined`(如 `resourceId` 为空)输出**空串**,
  不输出字面量 `null`。
- **分隔符固定为逗号**;不做可配置分隔符(最简)。

### 4.3 公式注入防护(CSV Injection,安全要点)

CSV 被 Excel/Sheets 打开时,以 `=`、`+`、`-`、`@`、制表符(0x09)、CR(0x0D)
**开头**的单元格可能被当**公式**执行(数据外泄 / 命令执行面)。本导出含**外部
可影响的文本**——尤其 `操作者`(来自用户填写的 `users.name`)、`动作`/`资源类型`/
`资源ID`(可能源自用户输入),必须中和:

- **中和规则**:对**文本列**,若字段首字符 ∈ {`=` `+` `-` `@` `\t` `\r`},在其前
  补一个单引号 `'`,再做 §4.2 的引号转义。
- **数值列豁免**:服务端自产的**数值列**(报表 `订单数` / `本位币金额` / `未计入
  笔数`、审计 `事件ID`)**不中和**——否则负数金额 `-123.45`(以 `-` 开头)会被加
  `'` 变成文本、在 Excel 里不再是数字。这些列的值由服务端生成(纯数字 / 十进制),
  不构成注入向量,保持其数字语义。
- 规则集中在 §3.6 的 CSV 序列化器一处实现,按「列是否数值」开关中和,便于测试。

### 4.4 列、表头与元信息(口径自描述)

**报表导出**(自描述:聚合结果需带口径上下文给离线读者):

- 文件结构 = **口径前置块(键,值 多行)** + 空行 + **表头行** + **数据行** +
  **合计行**。前置块示例(实际文案实施时定):
  `报表,销售汇总` / `口径,已实现` / `本位币,RMB` /
  `时间范围,2026-06-18 ~ 2026-06-25` / `分组,按状态` / `粒度,按月`。
- 列(数据区):

  | 表头 | 来源 | 数值列? |
  |---|---|---|
  | `分组` | `row.label`(已中文化,§2.2) | 否(文本,中和) |
  | `订单数` | `row.orderCount` | 是 |
  | `本位币金额(<currency>)` | `row.amountBase`(十进制字符串) | 是 |
  | `未计入笔数` | `row.unCostedCount` | 是 |

- **合计行**:`分组` 列写 `合计`,其余列取 `summary.totals`(同口径整数分汇总,
  与页面 tfoot 一致)。

**审计导出**(清晰矩形表,便于再导入;过滤上下文落在文件名 + 导出审计):

| 表头 | 来源 | 数值列? |
|---|---|---|
| `时间` | `createdAt`(§4.6 ISO) | 否 |
| `操作者` | `actorName ?? actorId` | 否(文本,中和) |
| `操作者类型` | `actorType` | 否 |
| `动作` | `action` | 否(文本,中和) |
| `资源类型` | `resourceType` | 否(文本,中和) |
| `资源ID` | `resourceId`(可空) | 否(文本,中和) |
| `事件ID` | `id`(字符串) | 是(纯数字,不中和) |

- **截断尾注**:审计命中 `cap`(§2.4)时,在数据行之后追加一行**明显的非数据
  标记**,如 `已截断,本次导出至多 <cap> 行,请收窄时间窗或过滤后重导`;并在导出
  审计 metadata 记 `truncated:true`(§3.5/§5)。报表分组天然有界,无截断行。

### 4.5 文件名方案(Content-Disposition)

- 方案:`<类型>_<细分>_<from>_<to>_<时间戳>.csv`(全 ASCII,`filename=` 直接可用,
  另附 `filename*=UTF-8''…` 兜底),时间戳用服务端 UTC 紧凑串(无 `:`,避免非法
  文件名字符):
  - 销售:`report-sales_<caliber>_<from>_<to>_<YYYYMMDDTHHMMSSZ>.csv`
  - 采购:`report-purchase_<caliber>_<from>_<to>_<…>.csv`
  - 审计:`audit-logs_<from>_<to>_<…>.csv`
- `from`/`to` 取入参(或默认窗)的 `YYYY-MM-DD`;时间戳由服务端 `Date` 生成
  (API 进程内允许)。

### 4.6 字段字符串化口径

- **时间**(审计 `createdAt`):导出为 **ISO 8601 UTC**(如
  `2026-06-25T11:38:58.517Z`)——无歧义、可排序、利于归档 / 再导入;不随导出者
  本地时区漂移(页面 `toLocaleString` 是展示用,导出以归档口径为准,二者有意
  不同)。
- **金额**(`amountBase`):**原样**取 `ReportsService` 的 `numeric(18,2)` 十进制
  字符串,**不加千分位**(页面的千分位仅展示),点号小数,使其可被当数字再导入。
- **整数**(`orderCount`/`unCostedCount`):十进制整数。
- **事件ID**(`id`):数字字符串原样(精度安全,§2.3)。
- **空值**:空字段(§4.2)。

### 4.7 原生 .xlsx(后续可选,本阶段不实现)

- **不在 1J 范围**,故 §3.2 的 `format` 仅 `csv`。在此仅记录将来若获批的路径:
  - 选型优先 **`exceljs`**(MIT、纯 JS、流式 writer、无原生编译),**固定版本 +
    供应链审查**后引入;不选 SheetJS `xlsx`(npm 社区版进度 / 历史告警需额外
    盯防,§2.5)。
  - 复用 §4.4 的同一套「列定义(表头 + 取值器 + 是否数值)」喂给 worksheet;
    **公式注入防护同样适用**——单元格统一以**文本 / 数值类型**写入,**绝不**写成
    公式类型,首字符危险的文本列同样中和。
  - 引入时需在 §8 评估体积 / 内存(xlsx 为打包格式,大结果集更吃内存),并把
    `xlsx` 取值在 `@IsIn` 放开。
- 在获批并完成上述前,**代码内不引入任何 Excel 库**,CSV 是 1J 的唯一交付格式。

## 5. 安全护栏与审计

导出把数据从「页面内可见」变成「可下载、可离线带走」,护栏重心是:**导出 ⊆ 可见**
(绝不导出调用者在页面上看不到的行)、**最小泄漏面**(不带详情/链内部/业务明文)、
**注入安全**(§4.3),以及**每次导出必留痕**(CLAUDE.md §6:export 是敏感操作)。
本节同时**钉死** §2/§3/§4 推来的待定项:权限是否细分、`cap` 取值、导出审计的
action/metadata 形状、失败是否记审计、审计与响应的时序。所有判定**服务端强制**
(UI 隐藏不是边界)。

### 5.1 护栏(服务端强制)

1. **导出 ⊆ 可见(核心)**:导出**复用既有查询服务的同一 dataScope 下推 + RLS
   上下文**(§1.4/§3.4),不另写取数路径。`own` 报表仅 `owner_user_id = caller`、
   `own` 审计仅 `actor_id = caller`;`all` 限本租户;跨租户由 `withTenantContext`
   + FORCE RLS 兜底。**任何过滤参数都无法导出页面上看不到的行**。
2. **最小泄漏面**:审计导出列 = 列表 summary 列,**不含** before/after/metadata、
   reason/ip/ua、requestId(详情专属)与 row_hash/prev_hash/hash_version(链内部)
   ——§2.3 已定;报表导出只含聚合行,本不涉及逐单明文。导出**不二次加工、不补
   字段、不外发**。
3. **权限码:默认复用 view,不细分 export(钉死)**:三端点复用 `reports:view` /
   `audit_logs:view`。理由:导出是「调用者本就能在页面 / JSON API 看到的数据」的
   **另一种序列化**(export ⊆ view),单独的 `*:export` 码**挡不住**已可见数据的
   外带(截图 / 脚本拉 JSON 同样可得);其增量风险(一键批量外带)由**审计留痕**
   而非新增权限门来治理。`reports:export` / `audit_logs:export` 的「可看不可导」
   职责分离留作**后续可选**(需改 seed + RBAC 矩阵,超出 1J 零新码范围)。
4. **行数上限 `cap`(钉死)**:审计导出服务端固定 **`cap = 50000` 行**(单次
   `LIMIT`,无 offset),护内存与软-DoS 面;命中即按 §4.4 输出截断尾注 + 审计
   `truncated:true`,**不静默截断**。报表分组天然有界,无 `cap`。`cap` 不由
   客户端传入。
5. **注入与下载安全**:CSV 公式注入按 §4.3 中和(文本列),数值列豁免;响应
   `Cache-Control: no-store`;文件名为受控 ASCII 方案(§4.5),不回显未净化的
   用户输入到 header。
6. **输入校验 + 防注入**:DTO whitelist + forbidNonWhitelisted(审计导出连
   `page`/`pageSize` 都拒收);`format` 仅 `csv`;所有过滤值**参数化下推**,导出层
   不拼 SQL(§3.2)。
7. **权限服务端强制**:`@RequirePermission` + PermissionGuard 判定;前端「导出」
   按钮显隐只是体验,无权用户直连端点仍 403(且该 403 已被既有
   `rbac:permission_denied` 留痕)。
8. **软-DoS 边界(已知)**:本阶段不做**每租户导出限频**(同 1E 下载令牌限频,
   属全局 rate-limiting 中间件);`cap` + 同步单请求 + 默认 7 天窗是当前的量级
   护栏,限频留后续(§8)。

### 5.2 审计(导出即被审计的敏感操作,钉死形状)

与 1I「读不审计」相反:**每次成功导出写一条审计**(CLAUDE.md §6 列明 export 为
敏感操作),经既有 `AuditService.log()` 入同一条不可篡改链(不改哈希/链结构)。

- **事件形状(钉死)**:

  | 导出 | `action` | `resource_type` | `resource_id` | `metadata`(标识 + 摘要) |
  |---|---|---|---|---|
  | 报表 | `report.exported` | `report` | `sales` / `purchase` | `{ side, format, caliber, groupBy, granularity, from, to, currency, rowCount }` |
  | 审计 | `audit_logs.exported` | `audit_log` | `null` | `{ format, from, to, actorType?, action?, resourceType?, resourceId?, requestId?, rowCount, truncated, cap }` |

  `actor_type='tenant_user'`、`actor_id = 调用者`;metadata **只记过滤条件 + 行数 +
  截断标记**,**绝不**记被导出的逐行内容 / 业务明文。

- **审计先于出数(fail-closed,钉死)**:CSV 在内存内构建完成(受 `cap` 界)后,
  **先写导出审计,成功再把字节响应给客户端**;**审计写失败 → 整个导出失败
  (5xx),不投递未留痕的导出**。这比 Files 的单文件 `file.downloaded` 走
  best-effort 更严:导出是**批量数据外带**,「无留痕不外带」是该敏感操作应有的
  fail-closed 取舍(代价:审计链不可用时导出一并不可用——而那时全应用写入本就
  不可用,可接受)。
- **失败不记成功事件**:导出在出数前失败(校验 / 查询 / 序列化错)**不写**
  `*.exported`;是否补一条 `*.export_failed` 留**后续可选**(默认成功才记),
  避免噪声。
- **不改写入路径**:重申——`AuditService`、哈希算法、`hash_version`、链结构、
  append-only 约束(022/023)一律不动;导出只是新增一种被记录的 action。

### 5.3 验证这些护栏(集成 / 单元测试覆盖,详列 §7)

- **导出 ⊆ 可见**:① 审计导出文件**不含** before/after/metadata/reason/ip/ua/
  requestId/hash 任一列;② `own` 调用者导出仅含自己发起的审计 / 自己的订单报表;
  ③ 跨租户过滤参数无法带出别租户行。
- **RBAC**:无 token → 401;无 `reports:view` / `audit_logs:view` → 403,且该 403
  命中既有 `rbac:permission_denied` 留痕。
- **导出即审计**:一次成功导出**恰好**写一条 `report.exported` /
  `audit_logs.exported`,metadata 含正确的过滤摘要 + `rowCount`(+ `truncated`),
  **不含业务明文**;导出后 `verify-chain` 仍 PASS(链未被削弱)。
- **fail-closed**:模拟审计写失败 → 导出请求失败、**无字节投递**(不产生未留痕
  导出)。
- **注入与编码**:用户名为 `=cmd()` 的行导出后单元格被中和为 `'=cmd()`(文本列);
  负数金额 `-123.45`(数值列)**不**被中和、保持数字;含逗号/引号/换行的值经
  RFC 4180 引号转义可正确还原;文件头含 UTF-8 BOM、行以 CRLF 结束。
- **cap / 截断**:构造 > `cap` 行的审计结果 → 文件含至多 `cap` 行 + 截断尾注,
  导出审计 metadata `truncated:true`、`rowCount = cap`。
- **报表口径一致**:同一入参下,导出的分组行 + 合计与 `GET
  /api/reports/*-summary` 的 JSON **逐值一致**(同一服务、同一 dataScope),证明
  无口径漂移。

## 6. 前端页面与导航

纯加法:**不新增页面、不新增路由、不新增导航**——导出入口直接挂在既有 `/reports`
与 `/audit-logs` 页面上,按**当前已应用的查询条件**触发下载。复用既有
`request<T>()` / `apiClient` / `ApiError` 按 status 映射文案 / 行内 `CSSProperties`
中文 / 服务端 403 优雅降级约定(同 reports / audit / AI 页)。无新依赖。

### 6.1 导出入口(两页各加一个「导出 CSV」按钮)

- **报表页**(`apps/web/src/reports/ReportsPage.tsx`):在控件行 / 表格附近加
  「导出 CSV」按钮。该页**每次控件变化即重载**,故「当前所见」= 当前控件值
  (`side` / `from` / `to` / `groupBy` / `granularity` / `caliber`);点击即用**这组
  当前值**调对应导出端点(`side==='sales'` → `sales-summary/export`,否则
  `purchase-summary/export`),导出文件与屏上表格同口径。
- **审计页**(`apps/web/src/audit/AuditLogsPage.tsx`):在过滤行 / 列表上方加
  「导出 CSV」按钮,用**当前已 `applied` 的过滤**(非 draft;与列表所见一致)调
  `audit-logs/export`,**不带** `page`/`pageSize`(导出是全量至 `cap`)。
  - ⚠️ **复用 `inclusiveTo`**:该页查询列表时已把 `to` 扩成当日末
    (`inclusiveTo`,1I QA 修复),导出**必须套同一转换**,否则导出集与列表集
    在「今天」边界上不一致。导出查询构造与列表查询走同一 `applied` + 同一
    `inclusiveTo`。

### 6.2 下载机制(Bearer 鉴权下的 blob 下载)

应用用 **Bearer token(非 cookie)**鉴权,故导出**不能**用 `<a href>` /
`window.open` 直接导航(那样不带 `Authorization` 头)。流程:

1. 以**带 `Authorization` 头的 fetch** 请求导出端点;
2. 非 2xx → 复用既有 `toApiError` 解析错误体抛 `ApiError`(403/400/500 统一处理);
3. 2xx → 取 `res.blob()`,并从 `Content-Disposition` 解析文件名(优先
   `filename*=UTF-8''…`,回退 `filename=`,再回退前端按类型+时间窗自拼);
4. `URL.createObjectURL(blob)` → 造一个 `<a download=filename>` → `click()` →
   移除节点 → **立即 `URL.revokeObjectURL`**。

该 object URL 是**瞬时**的、用完即撤销,仅用于触发浏览器另存,**非**导航 / history
写入、**不**落任何存储(隐私见 §6.5)。

### 6.3 api-client / 类型扩展

- 在 `lib/api-client.ts` 新增一个**低层下载 helper**(如 `downloadBlob(path)`),
  与 `request<T>()` 并列:共用 base URL + `Authorization` 头 + `ApiError` 映射,但
  **返回 `{ blob, filename }`** 而非解析 JSON。
- 新增三个 `apiClient` 方法,查询串复用既有 `reportQs` / `auditQs`(审计版**去掉**
  `page`/`pageSize`)+ `'/export'`:
  - `exportSalesSummary(query: ReportSummaryQuery)`
  - `exportPurchaseSummary(query: ReportSummaryQuery)`
  - `exportAuditLogs(query: ListAuditLogsQuery /* 不含分页 */)`
- **无需新响应类型**(返回 blob+filename,不建模 JSON);`format` 省略(服务端默认
  `csv`)或显式 `csv`。复用既有 `ReportSummaryQuery` / `ListAuditLogsQuery`。

### 6.4 状态、错误与 403 优雅降级

- 每页加 `exporting` 布尔(禁用按钮 + 显示「导出中…」)与 `exportError` 文案。
- **403**:导出与查看**同权限码**(`reports:view` / `audit_logs:view`),能看到
  页面者即能导出,故 403 主要是防御性路径;命中时按既有约定提示
  (报表「没有权限导出报表」/ 审计「没有权限导出审计日志」),不崩页。
- **其他错误**(500 / 网络):内联 `exportError` 提示,**不清空**已渲染的表格 /
  列表。
- **空结果**:报表无分组仍可导出(前置块 + 空表);审计 0 行导出仅表头——均不
  报错(与页面空态一致)。

### 6.5 只读与导航不变

- **纯加法**:不改两页既有的查询 / 展示逻辑,不新增路由,不动 `AppLayout` 导航
  (导出是页内动作,不是新页面)。无新依赖。
- **隐私**:导出内容(CSV 字节)仅以**瞬时 Blob + 用完即撤销的 object URL** 存在
  以触发另存;前端**不**写入 localStorage / sessionStorage / URL / console;刷新
  即重新拉取。与 1I / AI 页隐私约定一致(§浏览器 QA 做 spot-check)。

## 7. 测试

后端以 **vitest 集成测试**为主(`apps/api/test/export.integration.test.ts`,
supertest 打真实 HTTP,跑在 `kirindesk_test`,复用 `setup-integration` +
`fixtures`),覆盖「导出 = 同口径换序列化 + 一条审计」的全部护栏;CSV 序列化器与
fail-closed 走**单元测试**;前端走浏览器 QA(Playwright)。提交前置仍是
`pnpm verify` 全绿。

### 7.1 测试前置:fixture 复用(无新夹具,一处可注入)

- **权限已就绪**:`reports:view`(报表集成测试用)与 `audit_logs:view`(1I §6.1
  已补授 admin all / sales own / tenant2-admin all,`TEST_USER4` 无)均已在
  fixtures 中,导出复用同两码,**不新增权限夹具、不引 migration**。
- **可导数据复用**:报表导出复用既有报表测试已造的、带 `total_amount_base` 的
  订单;审计导出复用既有「被审计的写端点」产生的真实链合法事件(如各模块
  `*.created`),保证导出行真实、口径与列表一致。
- **`cap` 可注入(唯一夹具性改动)**:为测「截断」而不插 5 万行,`cap` 需可在测试
  里覆盖为很小值(如 2)——服务端常量默认 50000(§5.1),但以可注入形式
  (构造参数 / 配置)暴露给测试,**不改产品默认**。

### 7.2 集成测试用例(export.integration.test.ts)

**报表导出**

- happy:admin `GET /api/reports/sales-summary/export?from&to&caliber&groupBy`
  → 200、`Content-Type: text/csv; charset=utf-8`、`Content-Disposition:
  attachment; filename*…`、响应体以 **BOM** 起、含前置块 + 表头 + 分组行 + 合计行。
- **口径一致(关键)**:解析导出 CSV 的数据行,与同入参 `GET
  /api/reports/sales-summary` 的 JSON **逐值比对**(label / orderCount /
  amountBase / unCostedCount / totals 全等),证明无口径漂移;采购侧同测。
- 复用校验:`sales` 端点传 `groupBy=supplier` → 400(既有 per-side 校验经导出
  DTO 继承生效)。

**审计导出**

- happy:admin `GET /api/audit-logs/export?from&to` → 200 CSV,表头 = 7 个 summary
  列;**断言列与内容不含** before/after/metadata/reason/ip/ua/requestId/
  row_hash/prev_hash/hash_version 任一(最小泄漏面,§2.3/§5.1)。
- 过滤一致:按 `action`/`actorType`/`resourceType`/`from`-`to` 导出,行集合与
  同过滤 `GET /api/audit-logs` 列表一致(§6.1 的 `inclusiveTo` 边界同样在导出
  生效)。

**dataScope**

- `own`:sales(own)导出审计仅含 `actor_id = 自己` 的事件、导出报表仅覆盖自己
  名下订单;与 `all`(admin 见全租户)对照。

**跨租户隔离**

- tenant2-admin 导出不含 tenant1 行;过滤参数无法跨租户取数。

**RBAC**

- 无 token → 401;`TEST_USER4`(无 `reports:view` / `audit_logs:view`)对三端点
  → 403,且该 403 命中既有 `rbac:permission_denied` 留痕。

**导出即审计**

- 一次成功销售导出**恰好**写一条 `report.exported`(`resource_type=report`、
  `resource_id=sales`、metadata 含 side/format/caliber/groupBy/.../rowCount,**无
  业务明文**);一次审计导出写一条 `audit_logs.exported`(metadata 含
  format/from/to/过滤摘要/rowCount/truncated/cap)。
- 导出后 `verify-chain`(本租户链)仍 **PASS**(链未被削弱)。
- 计数稳定:一次导出 = 链中**恰好 +1** 条对应事件(非导出读端点不另写)。

**cap / 截断**

- 注入小 `cap`、构造 > cap 行的审计结果 → CSV 含**至多 cap 行 + 截断尾注**,
  导出审计 metadata `truncated:true`、`rowCount = cap`(不静默截断,§4.4/§5.2)。

**编码 / 注入(端到端断言)**

- 含 `=` 开头文本(如某 `users.name = '=cmd()'` 的操作者)导出后该单元格被中和为
  `'=cmd()`;负数金额 `-123.45`(数值列)**不**被中和、保持数字;含逗号/引号/
  换行的值经 RFC 4180 转义可还原;体含 BOM、行以 CRLF 结束。

### 7.3 单元测试(轻量,安全要点优先)

- **CSV 序列化器**(`common/export-csv.ts`,纯函数):逗号/引号/CRLF 转义、BOM
  前置、**公式注入中和(文本列)/ 数值列豁免**、`null`→空、CRLF 行尾——这是
  §4.3 安全要点的主测点。
- **文件名构造**:类型 + 时间窗 + 服务端时间戳的 ASCII 方案、非法字符规避(§4.5)。
- **fail-closed**:以 mock 让 `AuditService.log` 抛错 → `ReportsExportService` /
  `AuditExportService` 的导出方法**抛错、不返回文件**(证明无未留痕外带,§5.2);
  正常路径则「先审计、后返回 `{filename,mime,body}`」。
- **`listForExport` 复用**:断言其与 `list` 共享同一 WHERE 条件拼装(参数一致)
  且应用 `cap`、不带 offset。

### 7.4 前端浏览器 QA(Playwright + 真实 Chromium)

复用 1I QA 方式(两 dev server 真起、经 Vite 代理),用 Playwright 的
`download` 事件接住下载,截图 + 校验文件:

- 报表页:设好控件 → 点「导出 CSV」→ `waitForEvent('download')` →
  `suggestedFilename()` 匹配命名方案 → 读落盘内容,前置块/表头/分组行与屏上表格
  一致、含 BOM。
- 审计页:应用一个过滤 → 导出 → 下载文件表头为 7 列、**无** before/after 等列、
  行集合与列表一致(含「今天」边界 `inclusiveTo` 同步)。
- 无 `audit_logs:view` / `reports:view` 用户:导出走 403 防御路径,页面给「没有
  权限导出…」提示,不崩页。
- **隐私 spot-check**:grep 两页改动源确认零 `console.*` / 零 localStorage /
  sessionStorage / 零 URL-history 写入;在浏览器内确认下载用的 object URL 用完
  即撤销、存储里无 CSV 内容(导出内容只过瞬时 Blob)。

### 7.5 质量门槛

- `pnpm verify` 全绿:lint / format / typecheck / build / unit(含新增导出序列化
  + fail-closed 单测)/ integration(现有基础上 + 本阶段 export 用例)/ security 13。
- 安全回归脚本无需新增项即覆盖 append-only(022/023);**可选**追加一条静态检查:
  导出端点只读取数(不含业务写路由)、且 CSV 序列化器对文本列施加注入中和——
  作为「导出不放大攻击面」的护栏(默认以单测覆盖,静态项可选)。

## 8. 风险与回滚

本阶段是**零 migration、纯只读取数 + 一条审计、纯加法**的模块,整体风险等级低;
主要风险集中在「把已可见数据变成可批量带走的离线文件」——泄漏面、注入、口径一致与
软-DoS 要看牢,既有读路径与不可篡改性不受影响。

### 8.1 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **泄漏面扩大**:导出把「页面内可见」变成「可一键批量下载、可离线带走」,文件离开受控环境后 KirinDesk 无法再审计其访问 | 中 | 导出 ⊆ 可见(复用 dataScope+RLS,§5.1)、最小泄漏面(不带 before/after/详情/链内部,§2.3)、**每次导出必留痕且 fail-closed**(§5.2);文件离开后不可控是「可导出/带走」的固有属性——KirinDesk 的责任边界是「已收口、最小化、留痕的导出」,文件是客户自己的数据(CLAUDE.md §3),链上记录了谁在何时导出了什么范围/多少行。 |
| **CSV 公式注入(CSV Injection)**:含 `=`/`+`/`-`/`@` 等开头的单元格在 Excel/Sheets 被当公式执行 | 中 | §4.3 对**文本列**统一中和(补 `'`),数值列豁免;单元测试为主测点(§7.3);code review 红线。 |
| **口径漂移**:若导出不走同一查询,数值会与页面不一致 | 低 | 导出**复用同一** `ReportsService`/`AuditQueryService`(同一 WHERE、同一 dataScope、FE 同一 `inclusiveTo` 边界);集成测试**逐值比对**导出 CSV 与 JSON(§7.2)。 |
| **软-DoS / 内存**:大过滤集的审计导出在内存内构建 CSV,比分页读更重 | 低-中 | `cap=50000` 限行 + 默认 7 天窗 + 同步单请求(§5.1);超大导出的流式/分片/后台任务化留作后续;**每租户导出限频**留全局 rate-limiting 中间件(同 1E 下载令牌限频),本阶段不做。 |
| **fail-closed 把审计链可用性变成导出前提**:审计写失败则导出失败 | 低(已知取舍) | 刻意为之——不投递未留痕的批量外带(§5.2);且审计链不可用时全应用写入本就不可用,而读/页面仍可用。 |
| **Excel 中文乱码 / 文件名乱码** | 低 | UTF-8 **BOM**(§4.2)+ RFC 5987 `filename*`(§4.5)。 |
| **数值精度 / 数值被中和成文本**:bigint `id`、负数金额 | 低 | `id` 以字符串导出(§4.6);数值列**豁免**注入中和,负数金额仍为数字(§4.3);金额取原始十进制、不加千分位。 |
| **截断被误读为「全量」** | 低 | 不静默截断——显式尾注 + 审计 `truncated:true` + `rowCount`(§4.4/§5.2),提示收窄重导。 |
| **「可看即可导」无职责分离**:租户想要「可查看不可导出」时本阶段做不到 | 低(已知取舍) | 导出 ⊆ 可见,单独 `*:export` 码挡不住已可见数据的外带(§5.1.3);职责分离的 `reports:export`/`audit_logs:export` 留后续可选(需 seed + RBAC 矩阵改动)。 |
| **GET 带副作用(导出写审计)被预取/缓存放大** | 低 | FE 走 fetch+blob(非导航)、响应 `Cache-Control: no-store`;审计 append-only,重触发只是再记一条真实发生过的导出(§3.1)。 |
| **Excel 库供应链风险** | 低(本阶段规避) | 1J **只交付 CSV、不引任何 Excel 库**;`.xlsx` 留后续,引入需 pin 版本 + 供应链审查(§4.1/§4.7)。 |

### 8.2 回滚方案

- **回滚 = 纯代码回退**:本阶段不含任何 migration、不改产品 seed、不改
  `audit_logs`/`audit_log_chains`/订单表结构与既有数据,也不改既有查询服务的读
  语义——因此回滚是最安全的一类,`git revert` 相关提交即可,**无任何数据库状态
  需要反向迁移/对账**。
- **回退面**(都为新增 / 注册,删除即净移除,不留悬挂):
  - 后端:`ReportsExportService` + `AuditExportService` + `AuditQueryService.
    listForExport` 只读方法 + 三个 `/export` 路由与导出 DTO + CSV 序列化器
    (`common/export-csv.ts`),及其在既有 `ReportsModule` / `AuditViewerModule`
    的 provider 注册;
  - 前端:`/reports`、`/audit-logs` 两页的「导出 CSV」按钮 + `downloadBlob`
    helper + 三个 `apiClient` 导出方法;
  - 测试:`export.integration.test.ts` + 导出单测 + `cap` 可注入接缝。
- **下线粒度**:三端点彼此独立——可单独摘除审计导出(或仅报表导出)而不影响另一
  侧;被复用的读方法(`ReportsService.summary` / `AuditQueryService.list` /
  `getOne` / `verifyTenantChain`)**一字未动**,回退导出后 `/reports` 与
  `/audit-logs` 照常工作。
- **不可篡改性与既有数据不受影响**:导出从不写业务数据;它写的是 append-only 的
  `report.exported`/`audit_logs.exported` 审计事件——回退代码后**不再新增**此类
  事件,但**已写入的保留在链中**(真实发生过、不可也不应删除),`verify-chain`
  仍 PASS。`listForExport` 是只读新增,移除不影响 `list`/`getOne`/`verify`。无任何
  数据状态因本模块的存废而变化。

## 9. 验证命令与验收标准

### 9.1 验证命令

**完整质量门槛(提交前置)**

```bash
pnpm verify          # lint + format:check + typecheck + build + unit + integration + security 13
```

**分步 / 定向(开发中)**

```bash
# 仅本模块集成测试(快速回归)
pnpm --filter @kirindesk/api test:integration -- export

# 仅导出序列化 / fail-closed 单测
pnpm --filter @kirindesk/api test:unit -- export-csv

# 自动修格式(本仓约定:静默修,绿了再报告)
npx prettier --write "apps/api/src/**/export*.ts" "apps/web/src/reports/*.tsx" "apps/web/src/audit/*.tsx"

# 前端类型 + 构建
pnpm --filter @kirindesk/web build
```

**导出口径一致性(导出 CSV vs 既有 JSON 必须逐值一致)**

```bash
# dev server 起在 :3001,用 dev 租户
TOK=$(curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@dev.local","password":"dev-password-123","tenantSlug":"dev-tenant"}' \
  | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

Q='from=2026-06-01&to=2026-06-25&caliber=realized&groupBy=status'

# JSON(页面口径)
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/reports/sales-summary?$Q"
# CSV(导出)——分组行/合计应与上面 JSON 逐值一致
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/reports/sales-summary/export?$Q"

# 审计导出:表头 7 列、无 before/after,行集合与列表过滤一致
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/audit-logs/export?from=2026-06-18&to=2026-06-25"
```

**导出留痕与链完整性(导出后链仍 PASS)**

```bash
# 触发一次导出后,确认链中新增 report.exported / audit_logs.exported,且整链仍 PASS
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/audit-logs?action=report.exported&pageSize=5"
pnpm db:verify-chain tenant:00000000-0000-0000-0000-000000000001     # 应 PASS
```

**编码 / 注入冒烟(BOM + 公式中和)**

```bash
# 文件头应为 UTF-8 BOM(ef bb bf);含 =/+/-/@ 开头的文本列应被中和为 '…
curl -s -H "Authorization: Bearer $TOK" "localhost:3001/api/audit-logs/export?from=2026-06-18&to=2026-06-25" \
  | head -c 3 | xxd          # 期望 efbbbf
```

**前端浏览器 QA**:Playwright 跑 §7.4 脚本,用 `download` 事件接住下载,产出截图
(报表导出 / 审计导出 / 无权 403 / 隐私 spot-check),并校验落盘 CSV 内容与屏上
一致、含 BOM、无 before/after 列。

### 9.2 验收标准(全部满足方算完成)

**后端**

- [ ] `GET /api/reports/sales-summary/export`、`/purchase-summary/export`、
      `/api/audit-logs/export` 三端点存在,分别 `reports:view` / `audit_logs:view`
      守卫;无 token → 401,无权 → 403,`format` 非 `csv` → 400。
- [ ] **导出 = 同口径**:导出 CSV 的数据行 / 合计与同入参的 `*-summary` JSON、
      审计导出行集合与同过滤 `GET /api/audit-logs` 列表**逐值 / 同集**一致(含
      `inclusiveTo` 边界);复用既有 `ReportsService` / `AuditQueryService`,读
      语义**一字未改**。
- [ ] **导出 ⊆ 可见**:dataScope(`own` 仅自己、`all` 全租户)与跨租户 RLS 生效;
      审计导出**不含** before/after/metadata/reason/ip/ua/requestId/hash 任一列。
- [ ] **导出即审计(fail-closed)**:一次成功导出**恰好**写一条 `report.exported`
      /`audit_logs.exported`(metadata 为标识 + 过滤摘要 + rowCount(+truncated),
      **无业务明文**);审计写失败则导出失败、不投递;导出后 `verify-chain` 仍
      PASS。
- [ ] **格式正确**:CSV 为 UTF-8 + BOM、CRLF、RFC 4180 转义;**文本列公式注入
      中和、数值列豁免**;`id` 为字符串、金额为原始十进制;`Content-Type:
      text/csv`、`Content-Disposition: attachment; filename*…`、`Cache-Control:
      no-store`。
- [ ] **行上限**:审计导出 `cap=50000`(可测试注入);命中即输出截断尾注 +
      审计 `truncated:true`,**不静默截断**。
- [ ] **零 migration、零产品 seed 改动**;`AuditService` / 哈希算法 / 链结构 /
      append-only 约束、既有查询服务读语义一字未动;CSV 路径**零三方依赖**
      (无 Excel 库)。

**测试与门槛**

- [ ] `pnpm verify` 全绿:含本阶段新增 export 集成用例(§7.2)+ 序列化 /
      fail-closed 单测(§7.3);security 13/13。
- [ ] (可选)安全回归追加「导出端点只读取数、CSV 序列化器对文本列施加注入
      中和」静态检查通过。

**前端**

- [ ] `/reports` 与 `/audit-logs` 各有「导出 CSV」按钮,按**当前已应用条件**触发
      下载(报表用当前控件值、审计用 `applied` + `inclusiveTo`);Bearer 鉴权下
      经 fetch+blob 下载,文件名符合方案。
- [ ] 无相应权限 → 「没有权限导出…」提示,不崩页;其他错误内联提示、不清表。
- [ ] 浏览器 QA 截图齐全且功能正常;隐私 spot-check:零 `console.*`、零
      localStorage/sessionStorage、零 URL 写入,导出内容只过瞬时 Blob(object URL
      用完即撤销)。
- [ ] 纯加法:不新增路由 / 导航,不改两页既有查询与展示逻辑,无新依赖。

**流程(CLAUDE.md §1/§9)**

- [ ] 实施前本规划(§1–§9)经用户确认;实施按节推进,不擅自扩面。
- [ ] 完成后按 §9 报告:新增 / 修改 / 删除文件、执行命令、测试结果(通过 / 失败)、
      是否动 schema(否)、是否产生 secret(否)、遗留风险、建议下一步。

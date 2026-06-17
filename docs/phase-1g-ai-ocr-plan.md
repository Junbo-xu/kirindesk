# Phase 1G — AI/OCR 模块规划

## 1. 目标与范围

本阶段为 KirinDesk 引入 AI/OCR 能力的基础骨架，遵循 CLAUDE.md §7 Provider Abstraction Rules：

- **Provider 接口**：定义统一的 AI/OCR provider 接口（如 `OcrProvider` / `AiProvider`），所有调用方依赖接口而非具体厂商实现，便于后续替换。
- **Mock 实现**：仅提供 mock / 占位 provider 实现，返回可预测的假数据，用于本地开发与测试，不触达任何外部网络。
- **OCR 调用审计**：每一次 AI/OCR 调用（无论成功或失败）须可审计，记录调用方、租户、资源、provider、耗时与结果状态，写入 append-only 审计链（CLAUDE.md §6）。

**明确不做（本阶段范围外）**：

- 不接入真实的 DeepSeek、OpenAI、或任何商用 OCR 服务（CLAUDE.md §7 要求接真实厂商前须经批准）。
- 不创建或使用任何真实厂商密钥 / API key（CLAUDE.md §8）。
- 不发起任何向第三方传输客户业务数据的网络请求。

本阶段交付一个可工作、可测试、完全本地化的 AI/OCR 抽象层，为后续接入真实 provider 预留干净的插槽。

## 2. 数据库变更

**结论：本阶段优先复用既有表，预计不新增业务表。**

### 2.1 复用既有 `provider_invocations`（migration 020 + RLS 021）

Phase 0 已建好 `provider_invocations` 表，专用于记录 provider 调用，且当前代码尚未写入任何行。其列已覆盖本阶段 OCR/AI 调用审计的核心需求：

| 列 | 类型 | 本阶段用途 |
| --- | --- | --- |
| `id` | uuid PK | 调用记录主键 |
| `tenant_id` | uuid NOT NULL → tenants | 租户隔离（RLS 主键） |
| `provider_type` | varchar(30) | `'ocr'` / `'ai'` |
| `provider_name` | varchar(50) | 具体实现名，本阶段固定为 `'mock'` |
| `action` | varchar(100) | 调用动作，如 `'ocr.extract'` |
| `request_json` | jsonb | 入参摘要（**不落客户文件原文/敏感字段**，见 §5） |
| `response_json` | jsonb | 结果摘要 |
| `status` | varchar(20) | `'success'` / `'error'` |
| `duration_ms` | integer | 调用耗时 |
| `tokens_used` | integer | 预留，mock 阶段可空 |
| `cost_estimate` | decimal(10,4) | 预留，mock 阶段可空 |
| `invoked_by` | uuid NOT NULL | 调用方 user id（审计主体） |
| `created_at` | timestamptz | 调用时间 |

`provider_invocations` 已具备 `tenant_isolation_policy`（ENABLE + FORCE ROW LEVEL SECURITY，migration 021），与其它租户业务表一致，无需新增 RLS。

### 2.2 tenant_id 用法

所有写入均带 `tenant_id`，并在租户上下文事务内执行，RLS 在数据库层强制隔离，应用层不得跨租户读写调用记录。

### 2.3 索引

复用既有索引，无新增：

- `idx_provider_invocations_tenant_type (tenant_id, provider_type)`
- `idx_provider_invocations_created (created_at)`
- `idx_provider_invocations_status (status)`

### 2.4 软删除策略

调用记录属审计性质（append-only 倾向），本阶段**不提供软删除、也不提供更新/删除入口**；仅 INSERT + SELECT。是否对该表收紧为 SELECT,INSERT-only grant（对齐 §6 审计原则），在 §6 权限小节确认后于实现时通过迁移补授权，不在本节预先改动。

### 2.5 是否需要补充列 / 新迁移

核心需求已被覆盖，**本阶段倾向零迁移**。仅在实现期发现以下任一缺口时，才新增一支**纯加列、可逆**的迁移（不改既有列、不破坏已落数据）：

- 需关联触发调用的源文件（`files.id`）以建立「文件 → OCR 结果」可追溯链 —— 候选新增可空列 `source_file_id uuid`（不加硬 FK，或加 `ON DELETE SET NULL`，避免删文件级联影响审计记录）。
- 需收紧上表写入授权（见 §2.4 / §6）。

任何迁移在创建前仍须按 CLAUDE.md §5 单独列出表/列、tenant_id、RLS、索引、软删除、审计、回滚后再经批准，不在本规划内擅自落地。

### 2.6 回滚策略

- 若本阶段最终零迁移：无数据库回滚动作，回滚仅涉及代码层 provider/接口的移除。
- 若新增加列迁移：提供对应 `-- DOWN`（`DROP COLUMN` / `REVOKE`），且因均为加列/授权调整，回滚不丢失既有 `provider_invocations` 数据。

## 3. Provider 接口设计

沿用 Phase 1E `StorageProvider` 的既有模式：调用方只依赖接口，具体实现经 DI token 注入，厂商永不硬编码进业务逻辑（CLAUDE.md §7）。接口放在 `apps/api/src/ai/`（与 `storage/` 平行）。

### 3.1 设计原则

- **接口先行**：先落 `OcrProvider` / `AiProvider` 接口 + DI token，业务侧只引用接口类型。
- **入参不挟带原始文件**：OCR 输入用既有 `files.id`（+ 租户上下文）引用源文件，由 provider 实现侧按需向 StorageProvider 取流；接口不接受、不回传客户文件原始字节，避免敏感数据在层间流转 / 落审计（详见 §5）。
- **出参结构化、provider 中立**:返回归一化的结果对象,不暴露任何厂商专有字段 / 原始响应体。
- **错误 vendor-neutral**：与 `StorageException` 同理，provider 边界抛出统一异常，原始厂商错误（含 endpoint / key / quota 等基础设施细节）只在服务端记录摘要，绝不外泄到上层或客户端。

### 3.2 `OcrProvider` 接口

```ts
/** DI token for the active OcrProvider implementation. */
export const OCR_PROVIDER = 'OCR_PROVIDER';

export interface OcrExtractInput {
  /** Tenant-scoped id of an already-stored file (Phase 1E). The provider
   *  resolves bytes via StorageProvider; raw file content never crosses
   *  this interface. */
  fileId: string;
  /** Optional hint for downstream parsing, e.g. 'invoice' | 'order' | 'generic'. */
  docType?: string;
  /** Per-call overrides; provider clamps to its own maximum. */
  options?: OcrOptions;
}

export interface OcrOptions {
  /** Hard cap in ms for the whole provider call (see §3.5). */
  timeoutMs?: number;
  /** Preferred result language(s), BCP-47; advisory only. */
  languages?: string[];
}

export interface OcrField {
  key: string;
  value: string;
  /** 0..1 model confidence; mock returns a fixed value. */
  confidence: number;
}

export interface OcrExtractResult {
  /** Echoes the resolved provider name, e.g. 'mock'. */
  provider: string;
  /** Full recognized text, normalized to UTF-8. */
  text: string;
  /** Structured key/value extractions (may be empty). */
  fields: OcrField[];
  /** Aggregate confidence 0..1. */
  confidence: number;
  /** Provider-side processing time in ms (for audit duration_ms). */
  durationMs: number;
}

export interface OcrProvider {
  /** Name of this implementation, e.g. 'mock'. Recorded as provider_name. */
  readonly name: string;
  /** Runs OCR over the referenced file. Rejects with OcrProviderException on
   *  failure and OcrTimeoutException on deadline breach. */
  extract(input: OcrExtractInput): Promise<OcrExtractResult>;
}
```

### 3.3 `AiProvider` 接口

为后续结构化抽取 / 文本理解预留，本阶段同样只落接口 + mock。

```ts
/** DI token for the active AiProvider implementation. */
export const AI_PROVIDER = 'AI_PROVIDER';

export interface AiCompleteInput {
  /** Task discriminator, e.g. 'extract-order-fields' | 'summarize'. */
  task: string;
  /** Prompt / instruction text. Callers must not place raw customer files
   *  here; pass already-extracted, minimized text. */
  input: string;
  options?: AiOptions;
}

export interface AiOptions {
  timeoutMs?: number;
  /** Upper bound on generated tokens; provider clamps. */
  maxOutputTokens?: number;
}

export interface AiCompleteResult {
  provider: string;
  output: string;
  /** Optional usage for audit (tokens_used / cost_estimate); null in mock. */
  tokensUsed: number | null;
  durationMs: number;
}

export interface AiProvider {
  readonly name: string;
  complete(input: AiCompleteInput): Promise<AiCompleteResult>;
}
```

### 3.4 错误处理

新增 `apps/api/src/ai/ai.errors.ts`，与 `storage.errors.ts` 同构：

- `OcrProviderException` / `AiProviderException`（继承 `InternalServerErrorException`）：携带通用、厂商中立消息（如 `OCR operation failed: extract`），原始厂商错误只在 provider 边界 `logger.error` 记录摘要。
- `OcrTimeoutException` / `AiTimeoutException`（建议 `RequestTimeoutException`，HTTP 408）：超时显式区分，便于上层重试策略与审计 `status='error'` 归因。
- 入参校验（缺 `fileId`、文件不在本租户 / 不存在）走标准 `BadRequestException` / `NotFoundException`，由服务层在调用 provider 前完成，不进入 provider。
- **所有出口（成功 / 失败 / 超时）均写一条 `provider_invocations` 审计记录**（见 §5），失败路径 `status='error'`，不吞异常。

### 3.5 超时

- 每次调用有硬超时：`options.timeoutMs` → 缺省取 provider 配置默认（建议 OCR 30s、AI 30s），provider 实现内部对上限做 clamp，调用方不能设置超过 provider 允许的最大值。
- 超时以 provider 内部 `Promise.race` / `AbortController` 实现，到期抛 `OcrTimeoutException` / `AiTimeoutException`；mock 实现据 `timeoutMs` 模拟（可注入人为延迟用于测试超时路径）。
- 超时同样落审计（`status='error'`、记录 `duration_ms`）。

### 3.6 Provider 选择策略

- **DI token 绑定**：`OCR_PROVIDER` / `AI_PROVIDER` 在模块 `providers` 中绑定到具体实现；业务代码仅 `@Inject(OCR_PROVIDER)`，不感知具体类。
- **本阶段恒为 mock**：选择逻辑由配置驱动（如 `AI_OCR_PROVIDER=mock`），但本阶段唯一合法值为 `mock`；接入真实 DeepSeek/OpenAI/OCR 须经批准后另行扩展工厂（CLAUDE.md §7），不在本阶段开启。
- **工厂留扩展位**：用 `useFactory` 按配置返回实现，未知 / 未批准的 provider 名直接 fail-fast（启动期抛错），杜绝静默回退到真实厂商。
- **无密钥**：mock 不读取、不要求任何厂商 API key（CLAUDE.md §8）。

## 4. Mock 实现

落两个具体实现 `MockOcrProvider` / `MockAiProvider`（`apps/api/src/ai/`），实现 §3 接口，完全本地、零网络、零密钥。它们是本阶段唯一被 DI 绑定的 provider。

### 4.1 设计目标

- **确定性**：相同入参产生相同输出，便于集成测试断言（不使用 `Date.now()` 之外的随机源；耗时模拟用注入值而非真实随机）。
- **零外部依赖**:不发起任何网络请求、不读厂商 SDK、不读 API key;不真正解析文件字节,只按 `fileId` / `docType` 产出结构化假数据。
- **覆盖契约全路径**:能驱动出 success / error / timeout 三类出口,供审计与上层逻辑测试。

### 4.2 `MockOcrProvider`

```ts
@Injectable()
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';

  async extract(input: OcrExtractInput): Promise<OcrExtractResult> {
    // 校验已在服务层完成；此处仅按 docType 产出确定性假数据。
    // timeoutMs 模拟见 §4.4。
  }
}
```

- 行为：
  - 按 `docType` 返回一组**固定的**结构化字段，例如 `docType='invoice'` → `fields=[{key:'invoice_no',value:'MOCK-INV-0001',confidence:0.99}, {key:'amount',value:'1000.00',confidence:0.97}]`；`docType='order'` → 订单号 / 金额 / 客户等固定字段；其它 / 缺省 → `docType='generic'`，仅返回 `text` + 空 `fields`。
  - `text`:一段固定占位文本(明确标注 `[[MOCK OCR]]`),不含任何真实客户内容。
  - `confidence`:固定聚合值(如 0.95);`durationMs`:见 §4.4。
  - `provider`:`'mock'`。
- **不取文件字节**:mock 不调用 StorageProvider(真实实现才需要),避免在 mock 阶段引入对象存储耦合;`fileId` 仅回显 / 用于生成确定性内容。

### 4.3 `MockAiProvider`

```ts
@Injectable()
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';

  async complete(input: AiCompleteInput): Promise<AiCompleteResult> {
    // 按 task 返回确定性 output；tokensUsed 恒为 null（mock 不计费）。
  }
}
```

- 行为:按 `task` 返回确定性 `output`(如 `task='extract-order-fields'` → 一段固定 JSON 字符串;其它 → 回显式占位文本,标注 `[[MOCK AI]]`);`tokensUsed=null`;`provider='mock'`;`durationMs` 见 §4.4。

### 4.4 耗时与超时模拟

- 默认 `durationMs` 取一个小的固定值(如 5ms),保证测试快速且确定。
- 为测试 §3.5 超时路径,mock 支持**可注入的人为延迟**(通过可选配置 / 构造参数,而非随机):当注入延迟 > `options.timeoutMs`(经 clamp 后)时,按 §3.4 抛 `OcrTimeoutException` / `AiTimeoutException`。
- 为测试 error 路径,mock 支持一个**显式触发开关**(如约定 `docType='__force_error__'` / `task='__force_error__'`),抛 `OcrProviderException` / `AiProviderException`;该开关仅供测试,不属正常业务语义。

### 4.5 DI 绑定

- `AiModule` 中通过 §3.6 的 `useFactory` 按 `AI_OCR_PROVIDER` 配置返回实现;本阶段唯一合法值 `mock` → 绑定 `MockOcrProvider` / `MockAiProvider`,未知值启动期 fail-fast。
- 业务侧 `@Inject(OCR_PROVIDER)` / `@Inject(AI_PROVIDER)`,不感知 mock 类型。

### 4.6 测试支撑

- mock 实现自身随单元测试落地(断言确定性输出、超时分支、error 分支)。
- 上层 OCR 调用 + 审计写入的集成测试,直接依赖 DI 绑定的 mock,无需 fake/stub 网络层(对齐 Phase 1E in-memory fake storage 的做法)。

## 5. 审计要求

每一次 OCR/AI 调用都必须可审计（CLAUDE.md §6：AI/OCR calls 属须审计的敏感操作）。本阶段采用**两层记录**，职责分离，绝不吞调用事件。

### 5.1 两层记录的分工

| 层 | 写入表 | 性质 | 用途 |
| --- | --- | --- | --- |
| 操作记录 | `provider_invocations`（§2.1） | 逐次调用的运行明细 | provider / 动作 / 耗时 / 状态 / 入出参摘要，运维与排障、用量统计 |
| 审计链 | `audit_logs`（hash-chain，经 `AuditService.log`） | append-only 防篡改 | 「谁在何租户对何资源触发了一次 AI/OCR 调用」的合规事件 |

二者都写：`provider_invocations` 回答"这次调用发生了什么、花了多久"；`audit_logs` 回答"这是一笔不可篡改的敏感操作事件"。仅写其一不满足 §6。

### 5.2 写入时机：成功 / 失败 / 超时都记

- 服务层在 provider 调用**返回或抛出后**，无论 `success` / `error` / `timeout`，都写一条 `provider_invocations`（`status` 相应取值，记录 `duration_ms`）。
- 同一调用对应写一条 `audit_logs` 事件（见 5.4）。失败路径同样落审计，**不得在 catch 中静默吞掉**。
- 两次写入与业务事务的关系见 5.5。

### 5.3 `provider_invocations` 字段填充与脱敏

- `tenant_id` / `invoked_by`：取自当前租户上下文与调用者，RLS 强制隔离（§2.2）。
- `provider_type`：`'ocr'` / `'ai'`；`provider_name`：`'mock'`；`action`：如 `'ocr.extract'` / `'ai.complete'`。
- `request_json` / `response_json`：**只存摘要、不存敏感原文**——
  - 不落客户文件原始字节 / 全文（OCR `text` 全文不入库摘要，必要时仅存长度 / 哈希 / 截断预览）。
  - 不落任何厂商密钥、endpoint、原始厂商响应体。
  - OCR 入参摘要建议仅记 `{ fileId, docType }`；出参摘要仅记 `{ fieldCount, confidence, textLength }`。
  - AI 入参不记原始 prompt 全文（可能含最小化后的业务数据），仅记 `{ task, inputLength }`；出参记 `{ outputLength, tokensUsed }`。
- `status`：`'success'` / `'error'`（超时归 `'error'`，可在摘要中标 `reason:'timeout'`）。
- `duration_ms`：取 provider 返回的 `durationMs` 或服务层实测耗时。
- `tokens_used` / `cost_estimate`：mock 阶段可空。

### 5.4 `audit_logs` 事件（hash-chain）

通过既有 `AuditService.log(params: AuditLogParams)` 写入，参数：

- `tenantId`、`actorType:'tenant_user'`、`actorId`：当前调用者。
- `action`：`'provider.ocr.invoked'` / `'provider.ai.invoked'`（成功）；失败用 `'provider.ocr.failed'` / `'provider.ai.failed'` 或在 `metadata.status` 区分（实现期二选一，保持一致）。
- `resourceType`：`'provider_invocation'`；`resourceId`：写入的 `provider_invocations.id`，建立两层记录的可追溯关联。
- `metadata`：`{ providerType, providerName, action, status, durationMs, fileId? }`——**同样脱敏**，不放文件原文 / prompt 全文 / 密钥。
- `before` / `after`:OCR/AI 调用非状态变更,可省略,或 `after` 放结果摘要(字段数 / 置信度),不放原文。
- 审计链不可被普通应用逻辑编辑 / 删除(migration 023 已 REVOKE,§6 维持)。

### 5.5 一致性与失败处理

- `provider_invocations` 写入在**租户上下文事务**内执行(与其它业务表一致),拿到行 `id` 后再写 `audit_logs`(`resourceId` 引用它)。
- `AuditService` 自身在独立链事务中串接哈希(见现有实现),调用方按既有模块惯例在业务提交后写审计。
- 若 provider 调用成功但 `provider_invocations` 写入失败:按现有错误处理上抛,不静默;不产生"有调用却无记录"的静默缺口。
- **最小可用优先**:本阶段不引入异步审计队列 / 批量刷写;同步双写,简单可调试(Karpathy §2)。

### 5.6 不记录的内容(隐私红线,呼应 CLAUDE.md §3)

- 不记录客户文件原始字节、OCR 全文原文、AI prompt / output 的完整业务内容(仅摘要 / 长度 / 哈希)。
- 不记录任何厂商密钥、token、endpoint、原始厂商响应。
- 不将上述任何数据用于审计以外用途;审计数据本身亦受租户隔离与审计访问约束。

## 6. RBAC / 权限

沿用既有 RBAC：权限码 `module:action`，控制器用 `@RequirePermission(module, action)`，`dataScope`（all / own / none）由守卫注入到请求、在服务层下推到查询（CLAUDE.md §4：后端 DTO/API 不得泄字段，不能只靠前端隐藏）。

### 6.1 模块归属

AI/OCR 作为一个新模块 `ai`（中文「AI/OCR」），与 `files`(005)、`reports`(006) 平级，分配下一个模块 id `a0000000-0000-0000-0000-000000000008`。OCR 强依赖文件（§3 以 `files.id` 为入参），但权限自成一组，便于与文件权限分离授予。

### 6.2 权限码

seed 到 `db/seeds/002_permissions.sql`（模块 `ai`）：

| 权限码 | 名称 | action | 用途 |
| --- | --- | --- | --- |
| `ocr:view` | 查看 OCR 结果 | `view` | 读取既有调用记录 / OCR 结果（`provider_invocations` 中本租户、按 dataScope 可见的行） |
| `ocr:process` | 发起 OCR 识别 | `process` | 触发一次 OCR 调用（`POST` 识别端点） |
| `ai:view` | 查看 AI 结果 | `view` | 读取既有 AI 调用记录 |
| `ai:process` | 发起 AI 调用 | `process` | 触发一次 AI 补全 / 抽取调用 |

说明：

- 读（`:view`）与触发（`:process`）分离 —— 触发会产生用量 / 成本（未来接真实厂商），属更敏感动作，须单独授予，呼应 commission 的 view/lock 分离与职责分离原则。
- 本阶段先落 `ocr:*`（核心交付）；`ai:*` 一并 seed 以备 §3.3 的 `AiProvider`，若实现期暂不开放 AI 端点，可只 seed 不挂端点。
- 审计记录的查看复用既有 `audit_logs:view`，不在本模块新增审计查看权限。

### 6.3 各端点 RBAC 约束

（端点细节见 §7，此处仅列权限约束）

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `POST /api/ai/ocr` 发起 OCR | `ocr:process` | 入参 `fileId` 必须在调用者 dataScope 内（见 6.4），否则 403/404 |
| `GET /api/ai/ocr` 列表 | `ocr:view` | 仅返回本租户、dataScope 内的调用记录 |
| `GET /api/ai/ocr/:id` 详情 | `ocr:view` | 越界 id 视作不可见 → 404 |
| `POST /api/ai/complete` 发起 AI | `ai:process` | 同 OCR 的 scope 约束（输入须为已最小化文本，§5.3） |
| `GET /api/ai/complete` 列表 | `ai:view` | 同上 |
| `GET /api/ai/complete/:id` 详情 | `ai:view` | 同上 |

- 守卫在控制器层用 `@RequirePermission('ai', 'process' | 'view')`；无权限 → 403，且后端响应不得泄露越权数据（不仅前端隐藏）。
- 平台管理员身份与租户用户身份隔离（CLAUDE.md §4），平台 admin 无默认访问租户 OCR 数据的权限。

### 6.4 dataScope 如何作用

- **触发类（`:process`）**：调用前校验入参 `fileId` 是否落在调用者的 dataScope 内 —— `all` 可对本租户任意文件发起；`own` 仅限自己拥有 / 创建的文件；越界 → 视作不可见（404）或 403，不得静默放行。写入的 `provider_invocations.invoked_by` 记为当前用户，作为后续 `own` 归属依据。
- **读取类（`:view`）**：`dataScope` 下推到 `provider_invocations` 查询的 WHERE，在 RLS 租户隔离之上再按 scope 收窄 —— `all` 见本租户全部调用记录；`own` 仅见 `invoked_by = 当前用户` 的记录；`none` 见空集。scope 过滤发生在聚合 / 返回之前，own-scoped 调用者无法读到他人触发的记录（与 reports / commission 的 dataScope 下推一致）。
- dataScope 由现有守卫注入到 `req.dataScope`，服务层读取并下推；不在 SQL 之外的应用层做"取全量再过滤"，避免数据先离库再裁剪。

## 7. API 端点

控制器 `AiController`（`apps/api/src/ai/ai.controller.ts`），路由前缀 `api/ai`，整体 `@UseGuards(TenantAuthGuard, PermissionGuard)`，与 `FilesController` 同构：`@CurrentUser()` 取 `{ sub, tenantId }`，`req.dataScope` 注入 actor，逐端点 `@RequirePermission('ai', …)`。所有端点仅作用于当前租户（RLS），并按 §6.4 下推 dataScope。

### 7.1 actor 约定

```ts
private actor(user: TenantJwtUser, req: Request): RequestActor {
  return {
    userId: user.sub,
    tenantId: user.tenantId,
    dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
  };
}
```

### 7.2 OCR 端点

| 方法 / 路径 | 权限 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- | --- |
| `POST /api/ai/ocr` | `ocr:process` | body `{ fileId: uuid, docType?: string, options?: { timeoutMs?, languages? } }` | 调用结果 + 落库记录：`{ id, fileId, provider, status, text?, fields, confidence, durationMs, createdAt }` | 400 入参非法 / 404 fileId 不存在或越 scope / 408 超时 / 500 provider 失败（均已落审计，§5.2） |
| `GET /api/ai/ocr` | `ocr:view` | query 分页/过滤 `{ page?, pageSize?, status?, fileId? }` | 本租户、dataScope 内 OCR 调用记录分页列表（摘要字段，不含原文全文，§5.3） | 403 无权限 |
| `GET /api/ai/ocr/:id` | `ocr:view` | path `id`（ParseUUIDPipe） | 单条调用记录详情（摘要） | 404 越界 / 不存在（不区分，避免存在性泄露） |

- `POST /api/ai/ocr` 是触发类：先校验 `fileId` 在 dataScope 内（§6.4），再调 `OCR_PROVIDER.extract`，无论成功/失败/超时都写 `provider_invocations` + `audit_logs`（§5）。
- 列表 / 详情读取 `provider_invocations`（`provider_type='ocr'`），dataScope 下推到 WHERE。

### 7.3 AI 端点（随 `AiProvider` 一并预留）

| 方法 / 路径 | 权限 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- | --- |
| `POST /api/ai/complete` | `ai:process` | body `{ task: string, input: string, options?: { timeoutMs?, maxOutputTokens? } }` | `{ id, provider, status, output?, tokensUsed, durationMs, createdAt }` | 400 / 408 / 500，均落审计 |
| `GET /api/ai/complete` | `ai:view` | query `{ page?, pageSize?, status?, task? }` | dataScope 内 AI 调用记录列表（摘要） | 403 |
| `GET /api/ai/complete/:id` | `ai:view` | path `id` | 详情（摘要） | 404 |

- `input` 必须是已最小化文本，控制器 / 服务不接受原始客户文件字节（§3.3 / §5.6）。
- 实现期若暂不开放 AI，可只保留 OCR 端点，`ai:*` 权限先 seed 不挂路由（§6.2）。

### 7.4 DTO / 校验

- 入参用 class-validator DTO（如 `OcrExtractRequestDto`、`AiCompleteRequestDto`），`fileId` 校验 uuid，`docType` / `task` 长度与白名单约束，`options.timeoutMs` 上限 clamp（§3.5）。
- 列表 query 复用既有分页 DTO 风格（`page` / `pageSize` 带默认与上限）。
- 出参为显式塑形的响应对象 / DTO，**不直接回 `provider_invocations` 整行**，确保不泄 `request_json` / `response_json` 中的内部摘要或敏感字段（CLAUDE.md §4 后端不泄字段）。

### 7.5 不提供的端点

- 不提供调用记录的 `PUT` / `PATCH` / `DELETE` —— 记录为操作 / 审计性质，append-only，仅 INSERT + SELECT（§2.4）。
- 不提供任何"直传文件字节做 OCR"的端点 —— 一律先经 Files 模块入库再以 `fileId` 引用，避免旁路绕过文件审计 / 大小 / MIME 管控。
- 不暴露 provider 选择 / 切换端点 —— provider 由配置在启动期绑定（§3.6），运行期不可经 API 切换。

## 8. 风险与回滚

### 8.1 风险

| 风险 | 等级 | 说明 | 缓解 |
| --- | --- | --- | --- |
| 误接真实厂商 | 高 | provider 工厂若静默回退到真实 DeepSeek/OpenAI/OCR，会违反 CLAUDE.md §7 并外泄客户数据 | 工厂仅认 `mock`，未知/未批准值启动期 fail-fast；不读任何厂商 key；CI/集成测试断言绑定的是 mock（§3.6 / §4.5） |
| 敏感数据落审计 | 高 | 把客户文件原文 / OCR 全文 / AI prompt 全文 / 厂商响应写进 `provider_invocations` 或 `audit_logs` | §5.3 / §5.6 红线：只存摘要 / 长度 / 哈希；出参 DTO 显式塑形，不回整行；增加针对性测试断言无原文落库 |
| dataScope 越权读 / 触发 | 中 | own-scoped 用户读到他人调用记录，或对越界 `fileId` 发起 OCR | scope 下推到 WHERE（读）+ 触发前校验 `fileId` 在 scope 内（§6.4）；集成测试覆盖 own/all/none 三态 |
| 跨租户泄露 | 高 | 调用记录跨租户可见 | 复用 `provider_invocations` 既有 ENABLE+FORCE RLS（§2.1）；所有读写在租户上下文事务内 |
| 调用事件丢失（静默吞） | 中 | provider 失败 / 超时时未落记录，违反 §6 可审计 | 成功/失败/超时三路径都写记录，catch 不吞（§5.2 / §5.5）；测试覆盖 error 与 timeout 分支 |
| 文件审计旁路 | 中 | 出现"直传字节做 OCR"端点绕过 Files 的大小/MIME/审计 | 不提供直传端点，一律 `fileId` 引用（§7.5） |
| 超时 / 资源占用 | 低 | provider 调用无上限拖垮请求线程 | 硬超时 + clamp（§3.5）；mock 阶段耗时极小，真实接入前此风险不显现 |
| 平台管理员越权 | 中 | 平台 admin 默认可读租户 OCR 数据 | 平台身份与租户身份隔离（§6.3，CLAUDE.md §4），无默认访问 |
| 范围蔓延 | 低 | 本阶段误把真实 provider / 异步队列 / 用量计费做进来 | 严守"接口 + mock + 审计"边界（§1）；最小可用优先（§5.5） |

### 8.2 回滚

本阶段倾向**零迁移**（§2.5），回滚以代码层为主，风险低、可逆：

- **代码回滚**：`AiModule` 为新增、自包含模块，未改既有模块的业务逻辑（仅可能在 `app.module.ts` 注册一行 + seed 追加权限）。回滚 = 还原 `app.module.ts` 注册、移除 `apps/api/src/ai/` 目录，其余模块不受影响。
- **权限 seed 回滚**：`ai` 模块与 `ocr:*/ai:*` 权限为追加项；回滚删除对应 seed 行即可，不影响既有权限。`ai` 模块 id `…008` 为新增，不与既有冲突。
- **数据回滚**：若零迁移，`provider_invocations` 表 / RLS 在 Phase 0 即存在，本阶段仅向其 INSERT；回滚无需 DROP；已落的调用记录可保留（审计性质）或在确认后清理本阶段写入的行。
- **若实现期新增加列迁移**（§2.5 的可选项）：提供配套 `-- DOWN`（`DROP COLUMN` / `REVOKE`），均为加列 / 授权调整，回滚不丢失既有数据；该迁移须按 CLAUDE.md §5 单独审批后才落地。
- **端点回滚**：移除 `AiController` 后，前端无对应入口；不存在已对外发布的不可逆副作用（无外部网络调用、无第三方数据传输）。

### 8.3 回滚验证

- 回滚后跑全量质量门禁（lint / format / typecheck / build / unit / integration / security），确认其它模块测试仍全绿。
- 确认 `provider_invocations` 既有 RLS / 索引 / grant 未被本阶段改动残留影响（若零迁移则天然成立）。

## 9. 验证命令与验收标准

### 9.1 验证命令

全量质量门禁（与既有各 Phase 一致）：

```bash
pnpm verify            # = verify:full
# 展开：lint → format:check → typecheck → build → test:unit → test:integration → test:security
```

分步（排障时）：

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test:unit                                              # mock provider 单元测试
pnpm test:integration                                       # AiController + 审计 + dataScope 集成测试
pnpm test:security                                          # node scripts/security-regression.mjs
```

针对本模块的聚焦测试（实现期）：

```bash
pnpm --filter @kirindesk/api test:unit -- ai                # mock provider / 超时 / error 分支
pnpm --filter @kirindesk/api test:integration -- ai         # 端点 + RBAC + dataScope + 审计双写
```

手工 / 接口验证（本地，mock，无网络）：

```bash
# 先经 Files 模块上传得到 fileId，再发起 OCR（带租户 JWT）
curl -s -X POST localhost:3000/api/ai/ocr \
  -H "Authorization: Bearer <tenant_jwt>" -H "Content-Type: application/json" \
  -d '{"fileId":"<uuid>","docType":"invoice"}' | jq

# 列表与详情
curl -s localhost:3000/api/ai/ocr -H "Authorization: Bearer <tenant_jwt>" | jq
curl -s localhost:3000/api/ai/ocr/<id> -H "Authorization: Bearer <tenant_jwt>" | jq

# 审计双写抽查（确认 provider_invocations 落行 + audit_logs 事件，且无原文/密钥）
psql "$DATABASE_URL" -c "select id, provider_type, provider_name, action, status, duration_ms from provider_invocations order by created_at desc limit 5;"
psql "$DATABASE_URL" -c "select action, resource_type, resource_id from audit_logs where resource_type='provider_invocation' order by created_at desc limit 5;"
```

### 9.2 验收标准

接口与实现：

- [ ] `OcrProvider` / `AiProvider` 接口 + DI token 落地，业务侧仅依赖接口，无厂商硬编码（§3）。
- [ ] `MockOcrProvider` / `MockAiProvider` 输出确定性，零网络、零密钥；覆盖 success / error / timeout 三路径（§4）。
- [ ] provider 工厂仅认 `mock`，未知 / 未批准 provider 名启动期 fail-fast，无静默回退真实厂商（§3.6 / §8.1）。

端点与 RBAC：

- [ ] `POST /api/ai/ocr`、`GET /api/ai/ocr`、`GET /api/ai/ocr/:id` 行为符合 §7；AI 端点按实现期取舍。
- [ ] `ocr:*`（及 `ai:*`）权限码 seed 到 `ai` 模块；端点 `@RequirePermission` 约束正确：缺权限 → 403。
- [ ] dataScope：`own` 仅见 / 仅可触发自己的记录，`all` 见本租户全部，`none` 空集；越界 `fileId` → 404/403（§6.4）。
- [ ] 跨租户不可见（RLS）；平台管理员无默认访问租户 OCR 数据（§6.3）。

审计与隐私：

- [ ] 每次调用（成功 / 失败 / 超时）都写一条 `provider_invocations` + 一条 `audit_logs` 事件，`resourceId` 关联两者（§5.2 / §5.4）。
- [ ] 审计 / 记录中**无**客户文件原文、OCR 全文、AI prompt/output 全文、厂商密钥 / endpoint / 原始响应；仅摘要 / 长度 / 哈希（测试断言，§5.3 / §5.6）。
- [ ] 出参为显式塑形 DTO，不回 `provider_invocations` 整行（§7.4）。
- [ ] 无更新 / 删除调用记录的端点（append-only，§7.5）。

质量门禁与回滚：

- [ ] `pnpm verify` 全绿（lint / format / typecheck / build / unit / integration / security），且其它模块既有测试不回归。
- [ ] 安全回归 `test:security` 计数不低于既有基线（当前 13）。
- [ ] 若零迁移：无 DB 变更；若新增加列迁移，则经 §5 审批且 up→down→up 可逆验证通过（§8.2）。
- [ ] 回滚路径验证：移除 `AiModule` 后全量门禁仍绿，`provider_invocations` 既有 RLS / 索引 / grant 未受残留影响（§8.3）。

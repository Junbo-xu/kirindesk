# Phase 1G Web 前端规划 — AI/OCR 页面

后端(migration 035 + provider 抽象 + AiService 双写 + AiController + RBAC seed +
集成测试)已完成并推送。本文档规划其 web 前端,逐节确认后再实施。

## 1. 目标与范围

### 1.1 目标

为已落地的 AI/OCR 后端端点(`/api/ai/ocr`、`/api/ai/complete`)提供一个最小、
可用、可审计的前端入口,让持有相应权限的租户用户能够:

- 对一个**已在范围内的文件**发起 OCR 识别,并查看 mock provider 返回的确定性
  结果(文本片段、抽取字段、置信度)。
- 浏览本人(scope=own)或全租户(scope=all)的 OCR 调用记录列表,并查看单条
  调用的摘要详情。
- (次要)发起一次 AI 补全调用并查看输出,以及浏览 AI 调用记录。

前端只是后端能力的薄展示层:所有范围/权限/审计判断仍由后端决定,UI 不做任何
安全决策(CLAUDE.md §4「角色 UI 隐藏不够,后端才是真相源」)。

### 1.2 本阶段要做的页面 / 入口

沿用既有 `apps/web/src/<module>/` 目录 + `App.tsx` 路由 + 侧边导航的约定,新增:

- **AI/OCR 调用页**(`ai/OcrPage.tsx`,路由 `/ai/ocr`):
  - 顶部:选择一个范围内文件(文件 id 输入 / 从文件列表选取)+ docType 选填 +
    「发起 OCR」按钮,调用 `POST /api/ai/ocr`,在下方展示返回的字段表 + 文本片段
    + 置信度。
  - 下方:OCR 调用记录列表(`GET /api/ai/ocr`,分页),点击查看单条摘要
    (`GET /api/ai/ocr/:id`)。
- **AI 补全页**(`ai/CompletePage.tsx`,路由 `/ai/complete`):task + input 文本域
  + 「发起」按钮(`POST /api/ai/complete`),展示 output;下方 AI 调用记录列表
  (`GET /api/ai/complete`)+ 单条详情(`GET /api/ai/complete/:id`)。
- **导航入口**:在侧边栏「AI/OCR」分组下加两个链接(OCR / AI 补全),与既有
  commission 多页分组同构。
- **api-client 扩展**:在 `apps/web/src/lib/api-client.ts` 增加 `ocrExtract`、
  `listOcr`、`getOcr`、`aiComplete`、`listAiCompletions`、`getAiCompletion` 方法,
  类型加到 `lib/types.ts`,全部走既有 `request<T>()` 包装(自动带 token、统一
  `ApiError`)。

### 1.3 本阶段**不做**

- 不接任何真实 OCR/AI 厂商(CLAUDE.md §7,仍是 mock-only;前端不暴露任何
  vendor/API-key 概念)。
- 不在前端持久化或回显原始文件内容、OCR 全文、AI 完整 prompt/output 之外的东西;
  列表/详情只展示后端返回的摘要字段(后端本就只存摘要)。
- 不做文件上传(复用既有 `/files` 页面;OCR 页只消费已存在的 fileId)。
- 不做 update/delete 调用记录的 UI(后端 append-only,无此端点)。
- 不做导出、批量、轮询/实时刷新。

### 1.4 复用既有约定

- `request<T>()` + `apiClient` 单例(`lib/api-client.ts`),错误统一为 `ApiError`
  (含 `status`);页面按 `status` 映射 401/403/404/400/500 文案,与 FilesListPage
  同风格。
- 行内 `CSSProperties` 样式 + `system-ui` 字体 + 中文文案,与 FilesListPage /
  Reports / commission 页一致(本项目尚无组件库)。
- 分页约定:`{ page, pageSize }` 入参 + `Paginated<T> { data, total }` 出参。
- 403 优雅降级:无权限时展示「没有权限」提示而非崩溃(与 ReportsPage 一致)。

## 2. 文件清单

全部位于 `apps/web/`,纯前端;无数据库变更,无后端改动。

### 2.1 新增

- `apps/web/src/ai/OcrPage.tsx` — OCR 发起 + 调用记录列表 + 单条详情页
  (路由 `/ai/ocr`)。
- `apps/web/src/ai/CompletePage.tsx` — AI 补全发起 + 调用记录列表 + 单条详情页
  (路由 `/ai/complete`)。
- (可选)`apps/web/src/ai/format.ts` — 若 OCR/AI 两页有共用的小工具(如置信度
  百分比、状态中文映射、时间格式化),抽到此处;否则不建,避免过早抽象
  (CLAUDE.md §2)。先按「两页各自内联,出现重复再抽」推进。

### 2.2 修改

- `apps/web/src/lib/types.ts` — 新增 AI/OCR 响应类型:`OcrInvocationSummary`、
  `OcrExtractResponse`(含 `invocation` + `text`/`fields`/`confidence`)、
  `AiInvocationSummary`、`AiCompleteResponse`(含 `invocation` + `output`)、
  以及列表查询参数类型。字段名严格对齐后端 `toInvocationSummary()` 与
  controller 返回体(providerName/providerType/status/sourceFileId/durationMs
  等;**不含** tenant_id/request_json/response_json)。
- `apps/web/src/lib/api-client.ts` — 在 `apiClient` 对象中新增六个方法:
  `ocrExtract(body)`、`listOcr(query)`、`getOcr(id)`、`aiComplete(body)`、
  `listAiCompletions(query)`、`getAiCompletion(id)`,均走既有 `request<T>()`。
- `apps/web/src/App.tsx` — 新增两条受保护路由(`/ai/ocr`、`/ai/complete`)+
  两个 import。
- 侧边导航组件(`AppLayout` 所在文件,经核实为 `apps/web/src/components/` 下的
  布局组件)— 新增「AI/OCR」分组及两个链接。实施前先 `grep` 确认导航链接的
  确切定义位置(commission 分组的写法),照其同构添加。

### 2.3 不新增 / 不修改

- 无新增依赖(package.json 不动)。
- 无新增环境变量。
- 不动任何后端文件、migration、seed、测试 fixture。
- 不动 `vite.config`、tsconfig。

## 3. api-client / 类型扩展

字段名严格对齐后端实际返回(已核实 `ai-invocation.response.ts` 的
`toInvocationSummary()`、`ai.service.ts` 的 `OcrExtractResponse` /
`AiCompleteResponse` / `ListResult`、`ai.controller.ts` 的路由)。后端读端点
**不返回** `tenant_id` / `request_json` / `response_json`,前端类型也不声明这些。

### 3.1 `lib/types.ts` 新增类型

```ts
// 调用记录摘要 —— 对齐后端 InvocationSummary(createdAt 走 JSON 序列化为 string)
export interface InvocationSummary {
  id: string;
  providerType: string; // 'ocr' | 'ai'
  providerName: string; // mock-only:恒为 'mock'
  action: string; // 'ocr.extract' | 'ai.complete'
  status: string; // 'success' | 'error'
  durationMs: number | null;
  tokensUsed: number | null;
  sourceFileId: string | null;
  createdAt: string;
}

// 单个抽取字段 —— 对齐后端 OcrExtractResponse.fields[]
export interface OcrField {
  key: string;
  value: string;
  confidence: number;
}

// POST /api/ai/ocr 的返回体(实时结果;text/fields 不落库)
export interface OcrExtractResponse {
  invocation: InvocationSummary;
  text: string;
  fields: OcrField[];
  confidence: number;
}

// POST /api/ai/complete 的返回体(实时结果;output 不落库)
export interface AiCompleteResponse {
  invocation: InvocationSummary;
  output: string;
}

// 列表返回 —— 后端 ListResult 形状({data,page,pageSize,total},
// 与既有 Paginated<T> 的 {data,total} 兼容但多了 page/pageSize)
export interface InvocationListResult {
  data: InvocationSummary[];
  page: number;
  pageSize: number;
  total: number;
}

// 列表查询参数 —— 对齐后端 ListInvocationsQuery
export interface ListInvocationsQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  fileId?: string;
}
```

请求体类型(对齐 DTO,前端只发后端 DTO 接受的字段):

```ts
export interface OcrExtractRequestBody {
  fileId: string;
  docType?: string;
  options?: { timeoutMs?: number; languages?: string[] };
}

export interface AiCompleteRequestBody {
  task: string;
  input: string;
  options?: { timeoutMs?: number; maxOutputTokens?: number };
}
```

### 3.2 `lib/api-client.ts` 新增方法

全部走既有 `request<T>()`(自动带 bearer token、统一 `ApiError`)。查询串拼接
沿用既有写法(`URLSearchParams`,空值跳过),与 `listFiles` 同构。

```ts
// ---- OCR ----
ocrExtract(body: OcrExtractRequestBody): Promise<OcrExtractResponse> {
  return request<OcrExtractResponse>('/api/ai/ocr', {
    method: 'POST',
    body: JSON.stringify(body),
  });
},
listOcr(query: ListInvocationsQuery = {}): Promise<InvocationListResult> {
  const qs = /* URLSearchParams from page/pageSize/status/fileId */;
  return request<InvocationListResult>(`/api/ai/ocr${qs ? `?${qs}` : ''}`);
},
getOcr(id: string): Promise<InvocationSummary> {
  return request<InvocationSummary>(`/api/ai/ocr/${id}`);
},

// ---- AI completion ----
aiComplete(body: AiCompleteRequestBody): Promise<AiCompleteResponse> {
  return request<AiCompleteResponse>('/api/ai/complete', {
    method: 'POST',
    body: JSON.stringify(body),
  });
},
listAiCompletions(query: ListInvocationsQuery = {}): Promise<InvocationListResult> {
  const qs = /* same builder */;
  return request<InvocationListResult>(`/api/ai/complete${qs ? `?${qs}` : ''}`);
},
getAiCompletion(id: string): Promise<InvocationSummary> {
  return request<InvocationSummary>(`/api/ai/complete/${id}`);
},
```

方法签名要点:

- 六个方法对应六个后端路由,一一对齐;无 update/delete(后端 append-only)。
- `ocrExtract` / `aiComplete` 返回含实时 `text`/`fields`/`output` 的完整结果;
  `list*` / `get*` 只返回摘要(后端不持久化全文,故详情无全文,UI 也不展示)。
- 错误由 `request<T>()` 抛 `ApiError`(含 `status`),页面映射:
  400(校验失败)/401(未登录)/403(无权限)/404(文件或记录不在范围)/
  500(provider 失败)。

## 4. 路由与导航

### 4.1 路由(`apps/web/src/App.tsx`)

在受保护的 `<AppLayout>` 下新增两条路由,与既有 `/files`、`/reports`、
`/commission/*` 同级:

```tsx
<Route path="/ai/ocr" element={<OcrPage />} />
<Route path="/ai/complete" element={<CompletePage />} />
```

并在文件顶部加两个 import:

```tsx
import { OcrPage } from './ai/OcrPage';
import { CompletePage } from './ai/CompletePage';
```

每页内部自带「发起 + 列表 + 单条详情」三段,详情用页内状态(选中行)展开,
不单独开 `/ai/ocr/:id` 路由 —— 与 FilesListPage 的「单页内操作」风格一致,
避免为只读摘要多开一层路由。

### 4.2 导航(`apps/web/src/components/AppLayout.tsx`)

经核实,当前导航是 header 内一排扁平 `<Link>`(无分组下拉)。照此同构,在
「提成」与「设置」之间新增两个链接:

```tsx
<Link to="/ai/ocr">OCR</Link>
<Link to="/ai/complete">AI 补全</Link>
```

不引入分组组件 / 下拉(项目当前无此模式,过早抽象违反 CLAUDE.md §2);若日后
链接过多再统一重构导航,本阶段不做。

### 4.3 权限与导航的关系

导航链接对所有已登录租户用户可见;真正的访问控制在后端(`ocr:view` /
`ai:view` 等)。无权限用户点进页面后,首个 `list*` 请求返回 403,页面按 §3.2
的错误映射展示「没有权限查看」提示并停止渲染列表(与 ReportsPage 的 403 优雅
降级一致)。前端不依据权限隐藏链接 —— UI 隐藏不是安全边界(CLAUDE.md §4)。

## 5. 风险与回滚

### 5.1 风险

本阶段是纯前端薄展示层,无数据库变更、无后端改动,风险面小且可控:

- **隐私泄漏(最需警惕)**:OCR/AI 的实时返回含文本片段 / 抽取字段 / output。
  这些**只在「发起」那一次响应中**展示,绝不写入 localStorage、不进 URL query、
  不打 `console.log`、不随列表/详情请求再次拉取(后端本就不持久化全文,详情端点
  无全文)。缓解:页面状态(useState)持有实时结果,刷新即清空;列表/详情只显示
  摘要字段。Review 时逐一核对无持久化/无日志。
- **越权误判**:前端不得据权限隐藏功能来「保护」数据。所有 403/404 由后端裁定,
  前端只做文案降级。缓解:不在前端做任何范围/权限判断;§4.3 已明确。
- **错误文案误导**:provider mock 失败返回 500,若前端笼统显示「网络错误」会误导。
  缓解:按 `ApiError.status` 精确映射(400/401/403/404/500),500 显示「识别/调用
  失败,请重试」。
- **类型漂移**:前端类型若与后端返回不一致会静默错位。缓解:§3 类型已逐字段对齐
  已核实的后端源码;`pnpm verify` 的 typecheck 兜底。
- **误触发真实厂商**:无 —— 后端 provider 工厂只接受 `mock` 且 fail-fast
  (CLAUDE.md §7),前端无任何 vendor/API-key 入口。

### 5.2 回滚

- 全部改动集中在 `apps/web/`(两个新页面 + api-client/types/App.tsx/AppLayout.tsx
  四处修改),无 migration、无 seed、无后端、无依赖变更。
- 回滚 = `git revert <web commit>`(或删除新增文件 + 还原四处修改),后端与数据库
  完全不受影响,无需任何数据迁移或反向 migration。
- 文档(本规划)单独 docs commit,与代码 commit 分离,可独立保留或回滚。

### 5.3 兼容性

- 不改任何既有页面、路由、api-client 既有方法的签名,纯增量。既有 e2e/集成行为
  不受影响(后端零改动,256 集成 + 13 安全测试与本阶段无关,仍应保持绿)。

## 6. 验证命令与验收标准

### 6.1 验证命令

实施后、提交前必须全绿:

```bash
# 全量质量门(lint → format:check → typecheck → build → unit → integration → security)
pnpm verify
```

本阶段无后端/数据库改动,集成(256)+ 安全(13)应保持原状全绿;前端改动主要由
`typecheck` + `build` + `lint` + `format:check` 兜底。若只想快速本地确认前端:

```bash
pnpm --filter @kirindesk/web typecheck
pnpm --filter @kirindesk/web build
```

格式问题按 auto-memory 约定静默 `pnpm format` 修复后再跑,不单独汇报。

### 6.2 浏览器 QA(手动,实施后执行)

前置:`docker compose up`(postgres/redis/minio)、`pnpm db:migrate`、起 api +
web dev server。用 fixture/dev seed 中持有相应权限的租户用户登录。

OCR 页(`/ai/ocr`):

1. 先在 `/files` 上传一个文件,拿到其在范围内的 fileId。
2. 在 OCR 页填入该 fileId + docType=`invoice`,发起 → 看到确定性字段
   (invoice_no / amount)+ 文本片段含 `[[MOCK OCR]]` + 置信度 0.95。
3. 列表出现该条记录(providerName=mock、providerType=ocr、status=success),
   点开详情显示摘要字段、**无全文**。
4. 用一个不存在/越权的 fileId 发起 → 404 文案;非 uuid → 400 文案。
5. docType=`__force_error__` 发起 → 500 文案「识别失败,请重试」,且刷新列表
   能看到一条 status=error 记录。

AI 补全页(`/ai/complete`):

6. task=`extract-order-fields` + 任意 input,发起 → output 为确定性 JSON;
   tokensUsed 显示为空(null)。列表出现该记录。

权限 / 范围:

7. 用 scope=own 用户:列表只见本人发起的记录;访问他人记录详情 → 404 文案。
8. 用无 `ocr:view` / `ai:view` 权限的用户进页面 → 列表请求 403,页面显示
   「没有权限查看」并不渲染列表(优雅降级,不崩溃)。

隐私核对(关键):

9. 发起后打开浏览器 DevTools:确认 OCR 全文 / AI output 不出现在任何后续
   list/detail 响应里、不写入 localStorage/sessionStorage、不进 URL、无
   `console.log` 泄漏;刷新页面后实时结果清空。

### 6.3 验收标准

- `pnpm verify` 全绿(集成 256 / 安全 13 不回归)。
- §6.2 浏览器 QA 全部通过(成功路径、400/404/500、scope=own 隔离、403 降级、
  隐私核对)。
- 前端无新增依赖、无新增环境变量、无后端/migration/seed 改动(`git diff --stat`
  仅触及 `apps/web/` 的预期文件 + 本 docs)。
- 代码 commit 与 docs commit 分离;`git add` 显式列出文件,不含 `.env`/`dist`/
  `node_modules`/日志。
- 完成后更新 CLAUDE.md 阶段汇总,标记 Phase 1G(含 web)完成。

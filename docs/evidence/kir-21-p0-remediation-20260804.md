# KIR-21 P0 网页整改与验收证据

- 日期：2026-08-04
- 分支：`feat/kir-21-p0-remediation`
- 基线：`origin/main` @ `601163965ecd1f316c757e615550e23ed5ade4ee`
- 实现 commit：本文档与实现位于同一唯一提交，以 KIR-21 issue 回写的 commit work product 为准。

## 1. 基线与范围

KIR-21 指定的候选提交 `b248afc9d6b3a4b7f3b664fcd4660765f56b18bd` 与证据文件 `docs/evidence/kir-18-p0-remediation-20260804.md` 在当前本地与已配置远端均不可用。本次不猜测或伪造原候选内容，而是按相同验收口径从最新 `origin/main` 重建 A01 → A05 → A02 → A03 → A04 整改。

本次仅使用本地 `kirindesk_test` PostgreSQL、Redis DB 1 与 loopback 服务；未读取生产凭据或客户数据，未进行生产/预生产写入、备份恢复、正式 UAT 或 Go/No-Go。

## 2. 验收结论

| 项 | 结论 | 可复核证据 |
| --- | --- | --- |
| A01 | 通过 | Owner 对当前权限目录动态获得 `all` 作用域；询盘/商务/财务各自区分 loading、空数据、403、5xx 与重试；普通角色和跨租户负向路径保持拒绝。 |
| A05 | 通过 | 售后服务将未知原始状态归一为 `unknown`，返回 `UNKNOWN_AFTER_SALES_STATUS` 与原值；网页同时显示列表和详情诊断；`settled` 订单筛选不再被旧 DTO 拒绝。 |
| A02 | 通过 | 询盘草稿支持真实新建/编辑、多产品行校验、`source_version` 乐观锁、冲突后刷新恢复和带版本提交；写入 `inquiry.updated` 审计。 |
| A03 | 通过 | 失败脱敏任务可重试，已处理状态重复调用不增加 attempt；报价任务页支持录入、校正和完整版本序列；采购投影不暴露客户原文/联系信息。 |
| A04 | 通过 | 现有服务端收款闸门、冻结选价、冻结审批配置、逐级审批、自批/越级拒绝和受控下单均有负向测试；旧 PO 无新链接，不能进入 `/place` 或新履约链。 |

## 3. 实现与证据

### A01：Owner 作用域与页面加载态

- `apps/api/src/rbac/rbac.service.ts`：每次权限判定均在租户上下文内重查活跃、未删除的 `is_tenant_owner`；Owner 只对 `permissions` 表已知 code 获得 `all`，不接受任意未知 code。非 Owner 仍走现有角色授权与最小作用域合并逻辑。
- `apps/web/src/components/PageLoadState.tsx`：统一呈现 loading、403、5xx、其他错误与重试。
- `apps/web/src/workbench/InquiriesListPage.tsx`、`apps/web/src/commercial/CommercialFlowPage.tsx`、`apps/web/src/finance/FinanceWorkspacePage.tsx`：加载、失败和空数据分支互斥，失败不再被渲染为“暂无数据”。
- `apps/web/e2e/p0-remediation.spec.ts`：9 个 A01 Chromium 场景分别验证三页 loading/空数据、403/重试、500/重试。为可重复触发不同 HTTP 状态，这 9 个场景仅对列表请求使用 Playwright route 注入；页面本身、登录和权限导航仍运行真实应用。
- `apps/api/test/tenant-onboarding.integration.test.ts`：新 Owner 真实登录后，`/api/auth/me` 返回询盘、报价、财务与售后关键权限均为 `all`。
- `apps/api/test/inquiries-quotations.integration.test.ts`：采购角色访问询盘编辑返回 403，跨租户对象返回 404，跨租户报价任务列表为空。
- `apps/web/e2e/commercial-workflow.spec.ts`：无权用户直接访问 `/commercial` 被导航到 `/forbidden`。

### A05：售后状态归一与诊断

- `apps/api/src/samples-after-sales/after-sales-status.ts`：集中定义七个已知状态；其他字符串返回 `status: "unknown"`、诊断 code、原始状态和可读消息。
- `apps/api/src/samples-after-sales/samples-after-sales.service.ts`：所有售后 case response 统一通过归一函数，不将未知状态静默转为空列表或已知状态。
- `apps/web/src/samples-after-sales/AfterSalesPage.tsx`：列表显示“未知状态”与诊断小结，详情显示 `UNKNOWN_AFTER_SALES_STATUS` 和原始值。
- `apps/api/src/sales-orders/dto/list-sales-orders.query.ts`：列表筛选状态与当前服务端订单状态对齐，修复售后页加载 `settled` 订单时的错误告警。
- `apps/api/src/samples-after-sales/after-sales-status.test.ts`：全部 7 个已知状态和 1 个未知状态单测。
- `apps/web/e2e/p0-remediation.spec.ts`：由于当前数据库 CHECK 约束不允许插入未知状态，浏览器场景明确向售后列表注入符合 API 新契约的 `unknown + status_diagnostic` response，验证网页不静默。API 归一本身由上述 8 项单测直接证明。

### A02：询盘草稿编辑

- `db/migrations/051_kir_21_p0_web_remediation.sql` 与 `db/seeds/002_permissions.sql`：新增 `inquiries:update`，并仅为应用角色增加替换草稿产品行所需的 `DELETE ON inquiry_items`。
- `PATCH /api/inquiries/:id`：只允许草稿；重用创建校验；在同一事务内锁定询盘、校验 `expected_version`、替换产品行、增加 `source_version` 并写入前后快照审计。
- `POST /api/inquiries/:id/submit`：新客户端携带 `expected_version`；服务端保留可选字段兼容旧调用，新网页始终执行版本检查。
- `apps/web/src/workbench/InquiriesListPage.tsx`：真实新建/编辑表单、产品行增删、金额/数量字符串校验、冲突提示与自动刷新、草稿提交。
- API 集成测试同时发送两个 `expected_version=1` 更新，结果严格为一个 200 和一个 409；还覆盖零数量、普通采购角色、跨租户、旧版本提交与最新版本提交。
- Chromium 从网页新建两个产品行，先触发数量校验，再成功保存；使用第二个真实 API session 制造并发版本，网页呈现 409、刷新到 v2、编辑为 v3 并提交。

### A03：脱敏任务与供应商报价

- `POST /api/quote-tasks/:id/retry`：需要 `quotations:manage`、租户模块和 AI 配额检查。仅 `timeout/rate_limited/parse_failed/provider_failed` 启动新 attempt；`processing/ready/manually_corrected` 返回当前投影，并发竞争后重读最新状态。
- 第二次及以后的真实处理写入 `quote_task.retry_started`，包含 attempt 与 previous status；重复调用已就绪任务不产生第二条 retry audit。
- `apps/web/src/workbench/QuoteTasksPage.tsx`：任务选择、失败代码、幂等重试、供应商报价录入、乐观版本校正和 overwrite sequence 历史。
- API 集成测试使用明确命名的 `deepseek-contract-test-double` 分别触发 timeout、rate-limit、parse 和 provider failure；不宣称真实 AI 供应商已验证。rate-limit 失败后真实 retry 进入 ready/attempt 2，第二次 retry 仍为 attempt 2。
- Chromium 的初始失败投影由 route 可重复注入，点击后调用真实 retry endpoint，证明已处理任务的网页/服务端幂等路径。后续供应商报价 v1、校正 v2 与版本历史均走真实 HTTP 和 PostgreSQL。
- 脱敏证据：采购任务 response 不包含 `customer_code`、`customer_message` 或客户联系方式；销售报价投影不包含 supplier id/name/email、`source_text`、`entered_by` 或 `terms`。

### A04：服务端闸门与旧入口边界

- `apps/api/test/commercial-workflow.integration.test.ts`：选价快照与 PI 冻结、收款比例/凭证闸门、客户确认、收款内部确认和闸门开启均由服务端状态检查。
- `apps/web/e2e/commercial-workflow.spec.ts`：真实浏览器完成 PI 确认、外部到款事实登记、内部收款确认、闸门从阻断到开启，并下载水印 PI。
- `apps/api/test/procurement-requests.integration.test.ts`：闸门关闭时禁止创建采购请求；请求冻结当时审批配置；越级审批返回 403；配置中包含申请人时拒绝创建；最终审批后按供应商拆分 PO。
- 受控 `/place` 在同一事务中重查最新闸门；并发关闭闸门时 placement 等待锁并在提交后返回 409，PO、价格快照、异常与审计均无副作用。
- 最终价差保留精确金额/基点，超阈值产生 `business_exception.opened`、`purchase_price.exception` 和 `purchase_order.placed`。
- 旧 `POST /api/purchase-orders` 仍可作为独立历史/手工 PO 记录，但 `source_procurement_request_id` 为 null，没有 `sales_order_purchase_orders` 链接；调用受控 `/place` 返回 404，也因无销售订单链接而不能进入新履约收货链。这是明确边界，不将旧手工 PO 表述为新闭环能力。

## 4. 自动化验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @kirindesk/api typecheck` | 通过 |
| `pnpm --filter @kirindesk/api lint` | 通过 |
| `pnpm --filter @kirindesk/api build` | 通过 |
| `pnpm --filter @kirindesk/web typecheck` | 通过 |
| `pnpm --filter @kirindesk/web lint` | 通过 |
| `pnpm --filter @kirindesk/web build` | 通过，Vite 107 modules transformed |
| `pnpm --filter @kirindesk/api exec vitest run src/samples-after-sales/after-sales-status.test.ts` | 1 file / 8 tests 通过 |
| `pnpm --filter @kirindesk/api exec vitest run --config vitest.integration.config.ts test/tenant-onboarding.integration.test.ts test/inquiries-quotations.integration.test.ts test/commercial-workflow.integration.test.ts test/procurement-requests.integration.test.ts` | 4 files / 53 tests 通过 |
| `pnpm exec playwright test apps/web/e2e/p0-remediation.spec.ts --project=chromium` | 12/12 通过 |
| `pnpm exec playwright test apps/web/e2e/commercial-workflow.spec.ts apps/web/e2e/samples-after-sales.spec.ts --project=chromium` | 4/4 通过 |
| `TEST_DATABASE_URL=postgresql://kirindesk:kirindesk_dev_password@127.0.0.1:5432/kirindesk_test pnpm verify:migrations` | `051` DOWN、`050` DOWN、`050` UP、`051` UP 通过 |
| `git diff --check` | 通过 |

集成测试中“forced quotation audit failure”和“Audit chain head validation failed”日志是为证明审计失败时业务事务回滚而故意触发的负向场景；所属测试全部通过。

## 5. 关键审计事件

| 事件 | 触发条件 | 验证 |
| --- | --- | --- |
| `inquiry.updated` | 草稿版本更新成功 | 集成测试查询唯一 audit，`before.source_version=1`、`after.source_version=2` |
| `inquiry.submitted` | 草稿提交 | 现有提交事务与 quote task 创建测试覆盖 |
| `quote_task.retry_started` | 失败任务进入第 2+ attempt | 集成测试查询唯一 audit，`attempt=2`、`previous_status=rate_limited`；幂等重复 retry 不追加 |
| `supplier_quotation.created` / `supplier_quotation.replaced` | 报价 v1 / v2+ | overwrite sequence 严格按 v1、v2、v3 返回，并验证审计写入失败时报价回滚 |
| `procurement_request.created` / `purchase_order.generated` | 受控采购请求与拆 PO | 业务时间线集成测试覆盖 |
| `business_exception.opened` / `purchase_price.exception` / `purchase_order.placed` | 最终价超冻结阈值并受控下单 | 数据库 audit 与业务时间线均验证 |

## 6. 迁移、回滚与数据影响

### 前滚

- `051_kir_21_p0_web_remediation.sql` 只新增一条权限目录记录，并授予应用角色 `DELETE ON inquiry_items`。
- 无表重写、无数据转换、无不可逆 DDL。
- 新建环境在 module seed 之后由 `db/seeds/002_permissions.sql` 写入权限；已有 module 的环境由 051 幂等补入。
- 既有自定义角色不会自动获得 `inquiries:update`，仍需租户管理员按最小权限显式授予；Owner 由动态目录策略获得该权限。

### 运行时数据影响

- 编辑草稿时，产品行在单一事务内删除后重建，因此草稿产品行 ID 会变化。编辑只允许 `draft`，提交后的报价、选价与 PI 关联不会被重建路径触及。
- 冲突或审计写入失败时，询盘主记录、产品行与审计在同一数据库事务中回滚。

### 回滚

1. 将 API/Web 代码回滚到本实现之前的版本，避免旧 schema 上仍暴露草稿 PATCH。
2. 执行数据库 migrator 的 051 DOWN：删除相关 `role_permissions`、删除 `inquiries:update`，并撤销 `DELETE ON inquiry_items`。
3. 无需恢复业务表数据；已成功的历史草稿更新作为真实用户数据保留。

迁移演练已对本地 `kirindesk_test` 完成 051/050 DOWN 和 050/051 UP 往返，校验和一致。未对生产或预生产执行任何迁移。

## 7. 已知限制与发布边界

- 本证据不是独立审核结论；Kai 需对唯一实现 commit 进行代码审阅并在父任务给出通过或退回。
- 本次针对性浏览器验收使用 Chromium，没有声称全量 Firefox/WebKit 回归。
- A01 的可控 403/500 与 A05 的未知状态网页场景使用明确披露的 route 注入；真实权限拒绝、跨租户 RLS、状态归一、业务写入与审计由 API 集成/单元测试单独证明。
- AI 失败/重试使用合同测试替身，未使用真实供应商密钥，未将 mock 表述为真实外部服务能力。
- 旧手工 PO 仍可以作为独立历史记录维护；其不是新采购闭环的绕行入口，也不会被自动迁移到受控链。
- 本提交不解除 KIR-18 的 BLOCKED/NO-GO，不作为生产发布批准。

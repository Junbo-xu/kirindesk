# 阶段 2B：选价、PI 与收款闸门交付说明

- 状态：待 Kai 独立评审
- 分支：`feat/kir-7-stage-2b`
- 前置：阶段 2A 的询盘、采购报价、选价快照与事务内审计契约

## 结论

选价商业快照、精确毛利与阈值、线索升级、PI 版本、客户确认、追加式收款事实、内部收款复核和可配置采购闸门已经实现，并使用真实 PostgreSQL 持久化。报价覆盖不会重算既有选价、PI 或后续业务事实；金额与毛利全部由 PostgreSQL `numeric` 计算，不进入 JavaScript 浮点运算。

本阶段不宣称已接入银行、支付渠道、外部汇率服务或 PDF 渲染服务。`confirmed` 仅代表租户内部复核，所有收款响应固定返回 `payment_provider_status: not_verified`；跨币种 FX 由有权限用户录入并冻结；PI 当前导出为带水印的 HTML。

## 范围与验收

| 验收项 | 实现与证据 |
| --- | --- |
| 状态真实持久化、重启可恢复 | PI、冻结行、收款、复核决定和闸门评估写入 PostgreSQL；集成测试关闭并重建 Nest 应用后重新登录，仍可读取已确认 PI、两条收款和开启的闸门。 |
| 报价覆盖不污染历史事实 | 选价保存报价版本、报价行和商业字段快照；覆盖源报价后仍读取原采购单价、毛利和 PI 金额。 |
| 金额不使用 JS 浮点 | 售价、采购成本、行金额、PI 总额、收款和闸门金额均为 `numeric` 字符串；计算在 SQL 中执行。 |
| 失败与恢复路径明确 | 覆盖低毛利、报价过期、重复客户、重复收款、收款不足、凭证缺失、PI 旧版本确认和闸门旁路原因缺失。 |
| 权限、隔离、水印与审计 | 新权限逐端点校验；新表强制 RLS；跨租户读取返回 404；敏感页面及 PI HTML 带用户/租户水印；核心写入与 hash-chain 审计、业务事件同事务。 |
| 浏览器闭环 | Chromium 使用真实登录、API 和 PostgreSQL 完成 PI 查看、客户确认、记录收款、管理员复核、闸门开启和水印导出；无权限用户直达 `/commercial` 被送至 `/forbidden`。 |

## 业务闭环

1. 销售从有效供应商报价行创建选价，提交销售币种、销售单价和必要的跨币种 FX。
2. 服务端冻结报价版本、报价行、采购币种/成本、FX、销售价、毛利、阈值和公式版本。
3. 询盘线索升级客户时在租户内按标准化公司名或邮箱检查重复；本人范围外的命中只返回不含候选资料的冲突，由具备全租户客户权限的管理员关联恢复。
4. 销售从一个或多个冻结选价创建 PI；修订生成同一系列的新版本，不覆盖历史版本。
5. 低毛利 PI 禁止签发；具备权限的管理员填写原因后追加放行记录，再由销售签发。
6. 只有最新且已签发的 PI 可记录客户确认；确认事务生成 PI 来源销售订单和首条闸门评估。
7. 销售追加记录外部到款事实；凭证策略开启时缺少文件令牌即阻断，重复外部流水号返回冲突。
8. 财务/管理员追加确认或驳回决定；只有内部确认且满足凭证策略的金额进入闸门累计。
9. 闸门按租户配置的到款比例和凭证要求评估为 `blocked`、`open` 或 `bypassed`；关闭闸门配置必须填写旁路原因，恢复配置后重新评估且保留历史。

默认租户配置为最低毛利 `1500 bps`（15%）、采购闸门开启、要求 `10000 bps`（100%）到款且收款凭证必填。租户管理员可以调整阈值；所有阈值与每次评估结果都会冻结在业务记录中。

## 金额与历史事实

- 毛利公式版本为 `gross_margin_bps_v1`：`round((sales_price - purchase_fx_cost) / sales_price * 10000)`。
- `purchase_fx_cost = round(purchase_unit_price * fx_rate, 4)`，单件毛利保留 4 位，PI 行金额和总额保留 2 位。
- 同币种 FX 固定为 `1` 且来源为 `system`；跨币种 FX 必填，来源为 `manual`，捕获时间写入选价快照。
- 选价读取 `quote_selection_snapshots` 的冻结列和 JSON 快照；PI 行再次冻结选价快照，不追读当前供应商报价。
- 收款、复核决定和闸门评估均为追加式；驳回后通过新收款事实恢复，不修改旧记录。
- PI 商业内容及 `issued_by` / `issued_at` 签发事实由数据库触发器保护，只允许 `draft -> issued -> customer_confirmed` 状态转换；修订通过新版本表达。
- PI 来源订单禁止通过既有通用销售订单更新接口修改，避免绕过 PI 与闸门状态机。

## 数据模型与迁移

`046_stage_2b_commercial_workflow.sql` 是加法迁移并扩展以下模型：

- `inquiries.customer_id`：线索升级或关联后的租户复合外键。
- `quote_selection_snapshots`：销售价、FX、采购成本、毛利基点、阈值、状态和公式版本。
- `quote_selection_margin_approvals`：低毛利追加式放行事实。
- `proforma_invoices`：PI 系列、版本、状态、总额和客户确认信息。
- `proforma_invoice_series_selections`：选价只分配到一个 PI 系列。
- `proforma_invoice_items`：冻结 PI 行与选价 JSON 快照。
- `sales_orders.inquiry_id/source_pi_id`：PI 确认生成订单的来源链。
- `customer_receipts`：追加式外部到款事实及可选凭证文件引用。
- `customer_receipt_decisions`：独立的内部确认/驳回决定。
- `procurement_gate_evaluations`：每次闸门计算的追加式快照。

全部新业务表包含 `tenant_id`、租户复合外键、`ENABLE/FORCE RLS` 和最小应用角色授权。放行、PI 行、收款、复核决定及闸门评估禁止应用角色更新/删除；数据库触发器同时阻止高权限误改追加式事实。

## API 与页面

选价与客户：

- `POST /api/inquiries/:id/selections`
- `GET /api/inquiries/:id/selections`
- `POST /api/inquiries/:id/customer-upgrade`
- `PUT /api/inquiries/:id/customer-link`
- `POST /api/quote-selections/:id/margin-approval`

PI：

- `POST /api/inquiries/:id/proforma-invoices`
- `GET /api/inquiries/:id/proforma-invoices`
- `GET /api/proforma-invoices/:id`
- `POST /api/proforma-invoices/:id/revisions`
- `POST /api/proforma-invoices/:id/issue`
- `POST /api/proforma-invoices/:id/customer-confirm`
- `GET /api/proforma-invoices/:id/export`

收款、闸门与租户配置：

- `POST /api/sales-orders/:id/customer-receipts`
- `GET /api/sales-orders/:id/customer-receipts`
- `POST /api/customer-receipts/:id/review`
- `GET /api/sales-orders/:id/procurement-gate`
- `POST /api/sales-orders/:id/procurement-gate/evaluate`
- `GET /api/commercial-settings`
- `PUT /api/commercial-settings`

前端新增 `/commercial` 和导航“PI 与收款”。页面使用真实 API 完成选价、客户升级/关联、PI、文件凭证、收款、复核与闸门操作；导航按有效权限过滤，路由仍由 `PermissionRoute` 守卫，页面由 `SensitivePageWatermark` 包裹。

## 自动化证据

| 门禁 | 结果 |
| --- | --- |
| API/Web lint | 通过 |
| API/Web typecheck | 通过 |
| API/Web production build | 通过 |
| API 源码与测试格式检查 | 通过 |
| 全量 API integration | 22/22 文件、392/392 用例通过 |
| 2B 专项 integration | 1/1 文件、13/13 用例通过 |
| 2B 浏览器 E2E | Chromium 2/2 通过 |
| 迁移演练 | `046`、`045` 依次 down，再按原 checksum up 通过 |
| 安全回归 | 19/19 通过 |

2B 集成覆盖租户配置、本人及跨负责人重复客户阻断、候选资料保密、管理员关联恢复、公司名/邮箱部分键并发锁、报价覆盖后冻结快照、精确毛利、低毛利放行、PI 修订和旧版本阻断、签发事实不可变、水印导出、权限与跨租户隔离、客户确认、凭证缺失、重复流水、内部复核、收款不足、闸门旁路/恢复、追加式保护、审计链以及应用重启恢复。

## 回滚

迁移 DOWN 会删除本阶段 PI、PI 行、收款、复核决定、闸门评估和低毛利放行数据，并移除询盘客户链接及选价商业列，因此对已有验收或生产业务事实是破坏性操作。执行前必须备份新增表和扩展列；常规发布失败应优先前滚修复或仅回滚应用代码。

为使旧销售订单状态约束可恢复，DOWN 在删列/删表前执行确定性降级：

- `customer_confirmed`、`payment_gate_open`、`procurement` -> `confirmed`
- `fulfillment`、`delivered`、`finance_review`、`settled` -> `completed`
- `on_hold` -> `draft`

该映射不可逆，会丢失细分阶段语义。迁移演练只在数据库名严格为 `kirindesk_test` 时允许执行，并已验证 `046` 与 `045` 的 down/up checksum 一致。

代码回滚必须同步移除 `CommercialModule`、选价商业字段、PI 来源订单保护、前端 `/commercial`、权限种子和相关类型/API 客户端。只回滚前端不会丢数据；只回滚迁移而保留 API 会使请求失败，不可作为支持的拆分状态。

## 风险与未完成项

- 未接入银行或支付供应商；`confirmed` 是内部复核而非资金渠道验证，`payment_provider_status` 始终为 `not_verified`。
- 未接入外部汇率供应商；跨币种 FX 由有权限用户手工录入后冻结，后续如集成真实供应商必须新增来源、幂等、失败和对账方案，不能重算历史选价。
- PI 导出为带水印 HTML，不是 PDF；如后续要求 PDF，应使用受控渲染器并保留相同权限、审计和水印语义。
- 本阶段只开启采购资格闸门，不实现采购申请、到货/QC、发货、财务结算或支付对账等后续阶段。
- 当前工作树继承阶段 2A/2G 的未提交前置改动；本说明只陈述 2B 增量及在当前组合工作树上的验证结果。不得把这些前置内容混称为本阶段独立提交，也不得在 Kai 审核前合并 `main`。

除上述明确边界外，本阶段验收范围内没有已知未完成项。

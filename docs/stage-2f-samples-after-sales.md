# 阶段 2F：样品单与完整售后

## 1. 交付范围与验收

本阶段建立在阶段 2B 的冻结选价/PI，阶段 2D 的销售订单、履约与费用事实，以及阶段 2E 的不可变核对、利润与提成版本之上，交付以下真实持久化能力：

- 样品单独立状态机：`draft -> pending_approval -> approved/rejected -> dispatched -> delivered -> confirmed -> converted`，并支持对尚未转单的已批准、已寄出、已送达或已确认样品追加关闭事实。
- 样品创建时冻结选价、供应商报价版本、成本、售价、汇率与毛利输入；服务端按选价串行化检查样品数量上限。
- 样品转单新建询盘、选价快照、PI 和销售订单；所有金额从样品的 `source_snapshot` 读取，不回读可变报价行。
- 售后申请支持 `refund` 和 `compensation`，冻结申请时生效的审批流版本及每级审批人，并按顺序执行多级审批。
- 售后执行在同一事务内追加调整流水、新财务核对、`order_profit_rmb_v2` 利润快照和新提成候选版本；原利润快照、原锁定提成和原来源事实保持不变。
- Web 工作台 `/samples` 覆盖样品创建、提交、审批、寄出、送达、反馈、转单和关闭；`/after-sales` 覆盖审批流配置、申请、审批、执行和关闭。操作均调用真实 API，没有 UI mock。

本阶段不包含快递商 API、银行/支付渠道的自动退款或对账、会计凭证和提成实际发放。`after_sales_adjustments` 是经审批后的业务与财务事实，`external_reference` 用于防重；不应将其表述为已调用外部供应商完成打款。

## 2. 服务端契约

### 2.1 样品单

- `GET/POST /api/sample-orders`
- `GET /api/sample-orders/:id`
- `POST /api/sample-orders/:id/submit`
- `POST /api/sample-orders/:id/decision`
- `POST /api/sample-orders/:id/dispatch`
- `POST /api/sample-orders/:id/deliver`
- `POST /api/sample-orders/:id/confirm`
- `POST /api/sample-orders/:id/convert`
- `POST /api/sample-orders/:id/close`

创建时要求询盘已绑定客户，每个样品行必须对应该询盘的冻结选价。低毛利选价还必须已有独立的 `quote_selection_margin_approvals` 事实；该审批的 ID、审批人、原因和时间一并冻结进样品快照，样品审批不能替代毛利放行权限。事务对排序后的选价 UUID 取 PostgreSQL advisory lock，再统计已分配样品数量，使并发请求也无法超过选价数量。库约束与状态锁同时阻断重复审批、履约事实和转单。

审批人不得是样品创建人。`own` 数据范围只能访问自己的样品，且响应删除 `supplier_id`、`purchase_unit_cost` 和 `source_snapshot` 等采购敏感字段；`all` 范围才可查看完整冻结来源。

转单事务先锁定样品，要求每行恰好出现一次且转换数量不超过冻结上限；随后从样品行快照生成新的 `quote_selection_snapshots`、PI 行和销售订单行。如为低毛利，新选价只复制冻结的原毛利审批事实，不使用样品审批人补建放行记录。`sample_order_conversions` 与 `inquiries.source_sample_order_id` 均有租户内唯一约束，重试不会生成第二张订单。

### 2.2 售后

- `GET/PUT /api/after-sales/approval-config`
- `GET /api/after-sales-cases`
- `POST /api/sales-orders/:id/after-sales-cases`
- `GET /api/after-sales-cases/:id`
- `POST /api/after-sales-cases/:id/submit`
- `POST /api/after-sales-cases/:id/decisions`
- `POST /api/after-sales-cases/:id/start`
- `POST /api/after-sales-cases/:id/execute`
- `POST /api/after-sales-cases/:id/close`

替换审批流会追加新版本并停用旧版本；已创建申请复制当时的审批步骤，不受后续配置变更影响。服务端只允许当前最早未决策步骤的指定审批人操作，申请人不得审批自己的申请；跳级、重复决策和未全部通过就执行均 fail-closed。

执行要求 `all` 数据范围、已结算订单、当前最终利润和与之对应的已锁定提成基线。执行金额必须与审批金额一致，外币按本次冻结汇率换算为人民币。同一事务内追加：

1. 具有申请和外部参考双重唯一约束的 `after_sales_adjustments`。
2. 包含全部原核对项和新调整项的 `verified` 财务核对版本。
3. 通过 `supersedes_id` 连接原快照的 `order_profit_rmb_v2` 最终利润，累加退款/赔偿后从净利中扣减。
4. 沿用原规则版本和人员分配、重新计算的未锁定提成候选版本。

执行后订单回到 `finance_review`，新提成版本锁定前不得关闭售后；锁定后订单重新进入 `settled`，才可关闭或开始下一个售后修订。

## 3. 数据、权限与隔离

迁移 `050_stage_2f_samples_after_sales.sql` 新增 14 张业务表：

- 样品：`sample_orders`、`sample_order_items`、`sample_order_approvals`、`sample_shipments`、`sample_delivery_confirmations`、`sample_customer_feedback`、`sample_order_closures`、`sample_order_conversions`。
- 售后：`after_sales_approval_configs`、`after_sales_approval_config_steps`、`after_sales_cases`、`after_sales_case_approval_steps`、`after_sales_case_decisions`、`after_sales_adjustments`。

所有表都有 `tenant_id`、租户复合外键、`ENABLE/FORCE ROW LEVEL SECURITY` 和租户读写策略。事实表对应用角色只授予 `SELECT, INSERT`，并使用数据库触发器拒绝 `UPDATE, DELETE`；可变的主单表只允许服务端状态迁移，触发器阻断来源内容改写和非法跳转。交叉租户引用会在数据库层被拒绝。

产品权限 seed 新增：

- `sample_orders:view/create/approve/fulfill/convert`
- `after_sales:view/create/approve/execute`

列表和详情继续受 RBAC 的 `own/all/none` 数据范围限制；审批、履约、售后配置和执行还要求对应操作权限。所有状态变化、审批决定、转单和财务修订都追加审计日志与业务事件。

## 4. 验收证据

- 阶段 2F API 定向集成 2/2 通过，覆盖样品全状态、`own` 字段脱敏、跨租户 404、超量、低毛利未放行阻断、原毛利审批冻结与复制、重复转单、从冻结快照生成新选价/PI/订单、审批跳级、越权执行、金额不一致、重复调整、不可变旧版本、新利润/提成版本、锁定前禁止关闭和审计链。
- 阶段 2E 财务定向回归 4/4 通过，证明原核对、利润、提成以及过期候选恢复语义未被改写。
- Chromium 真实 API 浏览器验收 2/2 通过：销售与管理员切换完成样品创建至正式订单转换；管理员在售后工作台发布冻结的两级审批流。
- API/Web lint 和 typecheck 通过；Web production build 通过。
- 空数据库按 `049 -> 050 -> 049` 往返成功；存在 2F 事实时 DOWN 按设计拒绝，且整个降级事务回滚。

## 5. 迁移、风险与回滚

`050` UP 为增量建表，只为 `inquiries` 新增可空的 `source_sample_order_id`，并扩展 `finance_review_items` 的可选主体类型；不回填历史数据，也不会把旧订单伪装为样品转单或已有售后。部署时必须先执行迁移，再运行幂等权限 seed，最后发布 API/Web。

DOWN 在删除结构前会检查 `sample_orders`、`after_sales_approval_configs` 和财务售后核对项。只要存在任何 2F 持久化事实就拒绝降级，避免静默删除不可变链或在恢复旧核对约束时失败。数据环境回滚必须先停止 2F 写入、备份数据库、导出样品/售后/财务/审计版本链，经负责人批准数据迁移方案后才可重试 DOWN。应用回滚可先回退 Web/API 并保留新表只读，不必立即降级数据库。

已知风险与后续边界：

- 寄送、退款/赔偿执行和汇率来源由操作人录入可审计事实；对接快递、支付或汇率供应商需单独立项，并补充回调验证、幂等、失败处理和对账。
- 当前一个售后申请只能产生一条调整，且执行金额必须等于已审批金额；分批退款需拆分为多个申请，不能手工改写原流水。
- 新提成候选是应计修订，不是已发放记录；实际发放、撤销和会计期间仍属于独立提成发放域。

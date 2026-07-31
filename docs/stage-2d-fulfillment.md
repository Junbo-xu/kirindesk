# 阶段 2D：到货、QC、发货与签收

## 1. 交付范围

本阶段在阶段 2C 已批准的销售订单、采购申请、采购拆单和最终采购价契约上，交付以下真实持久化能力：

- 采购单按批次到货、到货行、QC 照片/文件、QC 接受与拒收数量。
- 租户级可配置业务员二次确认；配置在每张收货单创建时冻结，默认 fail-closed 为需要二次确认。
- 由已接受且完成确认的到货数量计算可发池；创建和实际发货时均重新校验，阻断超可发数量。
- 销售订单按批次发货、承运方、物流单号、追加式物流事件和签收凭证。
- 订单或发货批次级多币种费用；冻结原币、折 RMB 汇率、来源、采集时间和 RMB 结果。
- 非 RMB 费用可先以 `pending_fx` 持久化并生成可处理异常；补齐汇率后一次性冻结，禁止重算。
- 发货批次与已有客户收款流水显式关联；签收、收款核对和采购闸门状态互不耦合。
- 销售订单聚合状态由服务端根据采购单、到货、发货和签收子资源派生并同步。

本阶段不宣称已接入承运商 API、物流回调、银行/支付渠道、市场实时汇率或自动财务对账。物流事件和跨币种汇率是有权限用户记录的现实业务事实；收款仍沿用阶段 2B 的 `payment_provider_status: not_verified` 语义。

## 2. 服务端契约

### 2.1 到货与 QC

- `POST /api/purchase-orders/:id/goods-receipts`
- `POST /api/goods-receipts/:id/inspect`
- `POST /api/goods-receipts/:id/confirm`

采购员使用全域 `goods_receipts:manage` 权限创建和检查到货。订单负责人使用本人范围 `goods_receipts:confirm` 权限完成配置要求的二次确认。收货状态为 `pending -> inspected -> accepted/rejected`；未要求二次确认时，QC 后直接进入 `accepted/rejected`。

物理到货累计超过采购数量，或最终批次累计数量与采购数量不一致时，创建 `quantity_variance`。QC 拒收数量大于零时创建 `quality_variance`。异常进入现有分派、处理、解决和关闭流程，不用隐藏状态代替。

### 2.2 发货、物流与签收

- `POST /api/sales-orders/:id/shipments`
- `POST /api/shipments/:id/dispatch`
- `POST /api/shipments/:id/logistics-events`
- `POST /api/shipments/:id/deliver`

可发数量为：

`min(销售订单行数量, 已 accepted 到货行 QC 接受数量) - 已 dispatched/delivered 发货数量`

计算和比较均在 PostgreSQL `numeric` 上执行。草稿发货创建时先校验一次，发货事务锁定销售订单后再次校验，避免并发草稿绕过可发上限。签收必须关联同租户文件凭证，且签收时间不能早于发货时间。

### 2.3 费用与收款里程碑

- `POST /api/sales-orders/:id/expenses`
- `POST /api/order-expenses/:id/complete-fx`
- `POST /api/shipments/:id/customer-receipts`

RMB 费用固定使用 `fx_rate_to_rmb = 1` 和 `fx_source = currency_identity`。其他币种必须同时提供汇率、来源和采集时间；三项均缺失时记录 `pending_fx` 并创建 `missing_expense`，部分提供则拒绝。补齐后数据库触发器保护原币事实和完整 FX 快照，不允许再次修改。

发货与客户收款使用追加式关联表。仅 `recorded/confirmed` 收款可关联，关联不会确认收款、打开采购闸门或推动签收；签收也不会改变收款状态。

### 2.4 聚合状态和字段隔离

服务端按以下优先级派生本阶段相关聚合状态：

1. 所有销售订单行均已签收：`delivered`。
2. 存在到货或发货子资源：`fulfillment`。
3. 存在已下单/收货/关闭采购单：`procurement`。
4. `cancelled`、`on_hold`、`finance_review`、`settled` 不由本阶段倒退。

业务员履约响应只返回采购单号、币种、状态和行信息，不返回 `supplier_id`、供应商名称或联系方式。所有新增业务表带 `tenant_id`、复合租户外键、`ENABLE/FORCE ROW LEVEL SECURITY`，应用事务设置租户上下文。

## 3. 数据与权限

迁移 `048_stage_2d_fulfillment.sql` 新增：

- `goods_receipts`、`goods_receipt_items`、`goods_receipt_files`、`goods_receipt_confirmations`
- `shipments`、`shipment_items`、`logistics_events`
- `order_expenses`、`shipment_customer_receipts`

产品权限 seed 新增：

- `fulfillment:view`
- `goods_receipts:manage`
- `goods_receipts:confirm`
- `shipments:manage`
- `order_expenses:record`

部署既有环境时必须在迁移后运行幂等权限 seed，再开放 API；否则新增凭证链可见性权限尚不存在，履约写操作应保持不可用。

## 4. 验收证据

- API 与 Web typecheck、production build 通过。
- 改动范围 ESLint 与 Prettier 通过。
- 阶段 2B、2C、2D 相邻集成：3 个文件、25/25 用例通过。
- 阶段 2D 专项：4/4，通过分批到货、双确认、数量/质量异常、跨租户 404、供应商字段反向断言、超发 409、费用 FX 精度、汇率不可重算、物流、签收、收款解耦、聚合状态和审计链。
- 浏览器真实 API 闭环：2/2，通过上游询盘、PI、收款闸门、采购审批/下单后，由采购和业务两个角色完成到货/QC、双确认、发货、RMB 费用、物流、独立收款关联和签收。
- 安全回归：19/19，通过应用角色、启动密钥、RLS 和审计表修改限制。
- 迁移演练：`048 -> 047` 依次 DOWN，再 `047 -> 048` UP，原 checksum 一致。

## 5. 迁移、风险与回滚

迁移是增量建表，不回填旧订单，不把历史订单伪装成已完成新版履约。旧订单继续由原资源读取；阶段 2D API 只接受具备阶段 2B/2C 显式来源关系的新订单。

`048` DOWN 会删除全部阶段 2D 到货、QC、发货、物流、费用、签收和收款关联事实，并把 `quality_variance` 降级为 `quantity_variance` 后恢复旧约束。因此回滚属于有数据损失的阶段回退：仅可在隔离环境演练；生产候选如已有履约事实，必须先停止写入、备份并导出只读对账结果，由负责人单独批准后执行。

已知后续边界：

- 承运商接口、回调签名、幂等重试和供应商状态对账未接入。
- 外部市场汇率和银行汇率未接入；手工来源必须保留凭证并由阶段 2E 财务核对。
- `missing_expense`/差异异常不会因补录事实自动关闭，仍由独立异常处理流程记录责任人和解决说明。
- 阶段 2E 才交付财务核对、最终利润和提成；本阶段费用快照只是其不可变输入，不代表财务已确认。

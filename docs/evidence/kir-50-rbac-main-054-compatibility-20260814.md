# KIR-50 Fulfillment RBAC 与 main 旧 054 兼容修复证据

- PR: #13 `release/kir-48-fulfillment-loop`
- 修复基线: `04379f0b3ec702601cb5100b4e19cff7389bba21`
- 验证日期: 2026-08-14 UTC
- 范围: 仅测试数据库和 PR 分支；未部署生产，未执行生产迁移

## Fulfillment RBAC fail-closed

`FulfillmentService.salesOrder()` 只允许 `all` 返回租户范围，`own`/`assigned` 增加
owner 过滤；`none` 和所有未知值追加 `AND false`。所有履约读取和后续写路径均先经过该
sales order scope 检查。

回归用例对一个拥有权限、但 `data_scope` 分别为 `none` 和未知值 `unknown` 的用户执行：

- `GET /api/sales-orders/:id/fulfillment` → `404`
- `POST /api/purchase-orders/:id/goods-receipts` → `403`
- `POST /api/goods-receipts/:id/confirm` → `404`
- `POST /api/sales-orders/:id/shipments` → `404`
- `POST /api/sales-orders/:id/expenses` → `404`
- 请求前后 goods receipts、shipments、expenses 计数完全一致

验证命令与结果：

```text
pnpm --filter @kirindesk/api exec vitest run \
  --config vitest.integration.config.ts test/fulfillment.integration.test.ts

Test Files  1 passed (1)
Tests       6 passed (6)
```

原有跨租户、无权限以及正常 owner/all 用例保留在同一 integration suite 中。

## main 旧 054 安全前滚

保留已发布的 `054_kir_33_stage_a_quote_order_link.sql` 原文件名和 checksum
`7e8690c1c017d14a56839cd51bc20541f21b040a7a8272eb020d43492760f347`。后续转换迁移使用
`054_quote_to_sales_order.sql`，在旧 054 字段、约束和既有数据上前滚。

演练从空测试库安装至最新版本，再执行：

1. 最新 → 056 → 最新的 DOWN/UP checksum round-trip。
2. 回滚到已记录旧 054，创建独立 tenant/user/customer/quote/order 既有数据。
3. 前滚至 057，确认旧 054 ledger 行完全不变，quote source 数据、转换人和时间均保留。
4. 回滚到 051，再前滚至 057，确认自定义 role grants 保留。

验证结果：

```text
Migration round-trip passed: 057_customs_declarations.sql, 056_packing_driven_shipments.sql
Main forward migration passed: immutable 054_kir_33_stage_a_quote_order_link.sql, quote source data preserved
Legacy forward migration passed: immutable 051_kir_21_p0_web_remediation.sql, custom grants preserved
```

数据库单测同时验证已发布 051/054 checksum：

```text
Test Files  4 passed (4)
Tests       24 passed (24)
```

## CI 稳定性跟进

GitHub Actions 首轮在两个并发触发的 quality-gate 中分别暴露：

- main-054 rehearsal 依赖 integration seed 行；现已改为创建并清理独立 fixture。
- 真实 Chromium PDF 的 document-workbench 用例在冷启动时超过全局 30 秒；现仅为该用例设置
  60 秒上限。复跑结果为 20/20，真实 PDF 断言保留。

本地聚焦静态检查通过：Prettier、database lint/typecheck、API typecheck、database unit。
最终合并门禁以本证据提交推送后 PR #13 的 GitHub quality-gate 为准；不在 KIR-50 内自行合并。

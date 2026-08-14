# KIR-48 A–D 主线整合证据

## 整合结论

- 整合分支：`release/kir-48-fulfillment-loop`
- 验收来源提交：`4b3c4e52d732d2a3b3b9f29883eb866636582b22`
- 整合提交：`24743432f743ba493f34013f967082585a48ef41`
- 整合提交第一父提交为最新 `origin/main` 的 `690b7d783f7f6ae4aead4a2fa9145b3fb6022a78`，第二父提交为 A–D 验收提交。
- 最终 A–D 文件树与验收提交一致；已移除 Stage A PR #12 的旧 `054_kir_33_stage_a_quote_order_link.sql` 和旧证据文件，主线仅保留 `054_quote_to_sales_order.sql` 至 `057_customs_declarations.sql`，没有重复迁移。
- 四阶段证据均已核对：`kir-33-stage-a-20260809.md`、`kir-33-stage-b-20260809.md`、`kir-33-stage-c-20260810.md`、`kir-45-stage-d-20260811.md`。

## 整合门禁修复

- 纳入已发布的报价任务超时模拟稳定提交 `139dc6b0000f46e95a47260010d22c8ca1d7f22b`，避免首次列表请求被页面初始化提前消耗。
- 报关页面初始化增加过期 effect 取消，避免 React 严格模式下旧请求覆盖用户刚选择的锁定订单；Firefox 原失败场景专项复验 3/3 通过。
- 发布数据演练在投影到历史 049 基线时过滤 055 才允许的直生成采购关联行；本次明确报告省略 9 行，随后从 049 前滚到 057 并校验基线兼容数据不变。

## 验证结果

| 门禁 | 结果 |
| --- | --- |
| lint / Prettier / typecheck / build | 通过；ESLint 0 error，保留 3 条既有测试 `any` warning；Web 大包 warning 非阻断 |
| unit | database 23/23；API 96/96 |
| production dependency audit | 0 high/critical，0 active exceptions |
| API integration | 28/28 文件、442/442 用例通过 |
| security regression | 19/19 通过；包含 RLS、app role 写入拒绝和启动 fail-closed |
| 迁移往返 | 057、056 DOWN 后同序 UP 通过 |
| 旧环境前向升级 | 不可变 051 ledger 前滚至 057，通过且自定义授权保留 |
| Web E2E | Chromium、Firefox、WebKit 共 99/99 通过；包含报价建单、采购拆单、PL 发货签收、报关与真实 PDF/Files 链路 |
| release data | 049 → 057 通过；保留 2,550 行基线兼容数据，0 orphan，900 行审计链完整；备份恢复对账通过 |
| release storage | 恢复并校验 141 个对象，通过 SHA-256 canary |
| release runtime | 120 请求 overall p95 314.5 ms（门限 500 ms）；只读/隐藏回滚模式通过 |

## 迁移与回滚

- 本任务未部署生产、未连接生产数据库，也未执行生产迁移。
- 首选应用回滚：部署上一版 API/Web，保留 054–057 结构与业务证据，随后前滚修复。
- 数据库 DOWN 仅限隔离环境或完成备份、影响清单核对并获负责人批准后执行：057 会删除报关集合、版本、操作历史和报关权限；056 会丢失箱级快照、签收附件关联和幂等历史；055/054 会丢失订单单证、直生成采购与报价来源关系元数据。
- 057 生成事务失败会回滚 Files/版本/配额；强制中断可能留下无 Files 行引用的对象，需按孤儿 storage key 受控清理。

## 已知风险

- Web 主包仍有大于 500 kB 的既有非阻断告警，后续可独立做路由级拆包。
- 报关 PDF 是可审核样单和委托书，不是海关电子申报报文；真实海关供应商接入需另立项。
- 生产迁移、生产发布和生产数据处置不属于 KIR-48 范围。

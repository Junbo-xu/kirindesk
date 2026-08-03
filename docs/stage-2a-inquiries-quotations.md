# 阶段 2A：询盘、报价与 DeepSeek 交付说明

## 结论

询盘、脱敏任务、当前有效报价、原子报价行、覆盖审计和选价快照的业务闭环已实现并通过自动化验证。DeepSeek 官方 API adapter、错误映射和费用护栏已实现；2026-07-31 的一次官方合成 fixture smoke 返回 HTTP 200 并通过严格 JSON 校验。负责人随后明确要求本轮跳过 Paperclip Secret 绑定，因此 Secret 持久化作为延期运维项，不阻塞阶段 2A 代码交付。

负责人最终确认 DeepSeek 官方 API、人民币 1 元硬上限、最多 5 次真实 smoke 请求和仅合成测试数据。实现固定官方 `https://api.deepseek.com/chat/completions` 和 `deepseek-chat`，所有配置缺失或越界均在启动期失败关闭。运行时默认仍为 `mock`；没有 Secret 时不能误启用真实 provider。

## 范围与验收

### 已完成

- 业务员创建包含多个产品行的询盘，数量和目标价使用 PostgreSQL `numeric`，API 始终返回十进制字符串。
- 询盘提交与报价任务创建在同一租户事务中提交；审计链写入失败时整体回滚。
- 报价任务保存明确的 `pending`、`processing`、`ready`、`timeout`、`rate_limited`、`parse_failed`、`provider_failed` 和 `manually_corrected` 状态。
- 结构化输出严格校验字段集合、产品行全集、产品行 ID、数量、单位和已知客户身份信息；失败后可重试或由采购员人工校正。
- 两分钟处理租约允许进程失联后的安全重试，近期处理中任务仍拒绝重复执行。
- 每个询盘和供应商只保留一条当前报价；报价覆盖使用任务行锁和 `expected_version` CAS，同版本并发请求只有一个成功。
- 报价头、原子报价行和 hash-chain 审计在同一事务中提交；审计插入失败、链头内容校验失败或链头 CAS 失败均回滚报价变更。
- 授权采购角色可通过独立端点重建无缺口的报价版本序列；普通报价 API 只返回当前记录。
- 销售投影隐藏供应商 ID、录入人、报价原文和自由文本条款，并拒绝在销售可见字段中写入已知供应商名称、联系人、邮箱或电话。
- 采购投影只返回脱敏摘要、产品需求和客户国家，不返回客户代号、客户原文或联系方式。
- 供应商报价的完整 before/after 证据不进入通用审计列表、详情或导出，只能通过 `quotations:audit` 权限的专用覆盖序列端点读取。
- 选价快照以显式字段白名单保存自包含数据，所有 decimal 值冻结为字符串；数据库触发器禁止更新或删除。后续报价覆盖不会修改或阻断既有快照。
- 新表全部启用并强制 RLS；关系使用租户复合键，应用角色只获得最小表权限。
- 文本 AI provider 可显式选择 `deepseek`；官方 endpoint、`deepseek-chat`、API key、人民币预算和最大调用数必须同时配置，任一缺失或越界即拒绝启动，不回退 mock。
- DeepSeek adapter 当前只接受显式标记的 `synthetic_test` 数据；普通 AI API 和询盘工作流默认标记为业务数据，在现有批准边界下会在发网前拒绝并进入人工兜底。
- 每次请求同时受 20,000 输入字节、4,000 输出 token 和 30 秒约束；整个验证进程最多 5 次调用、人民币 1 元累计预算，预算按每百万 token 人民币 50 元的保守费率预留。
- provider invocation 只保存任务名、输入/输出长度、token 数和保守费用估算，不保存 prompt、key 或供应商原始错误/响应。

### 延期项

- Paperclip `DEEPSEEK_API_KEY` Secret 的创建、轮换和 `secret_ref` 绑定按负责人 2026-07-31 的意见延期到其出差返回后处理。仓库、普通环境文件和数据库均未写入 Key。
- 现有批准仅允许合成测试数据；真实客户或业务数据继续禁止外发。要在生产询盘上启用 DeepSeek，必须另行扩大数据处理/出境批准并修改代码中的数据分类门禁。

## API 与数据模型

主要端点：

- `POST /api/inquiries`、`GET /api/inquiries`、`GET /api/inquiries/:id`
- `POST /api/inquiries/:id/submit`、`POST /api/inquiries/:id/sanitize`
- `GET /api/quote-tasks`、`GET /api/quote-tasks/:id`、`PUT /api/quote-tasks/:id/manual`
- `GET /api/quote-tasks/:id/quotations`、`PUT /api/quote-tasks/:id/quotations`
- `GET /api/inquiries/:id/quotations`
- `POST /api/inquiries/:id/selections`、`GET /api/inquiries/:id/selections`
- `GET /api/quotations/:id/overwrite-sequence`

迁移 `044_stage_2a_inquiries_quotations.sql` 新增：

- `inquiries`、`inquiry_items`
- `quote_tasks`
- `supplier_quotations`、`supplier_quotation_lines`
- `quote_selection_snapshots`

## 自动化证据

- `pnpm --filter @kirindesk/api test:unit`：13 个文件、76 个用例通过；其中 DeepSeek 配置、adapter、mock 和询盘脱敏专项 4 个文件、32 个用例通过。
- DeepSeek adapter 受控上游测试真实经过 HTTP/AbortController，覆盖结构化成功、业务数据发网前拒绝、超时、HTTP 429、非 JSON、结构缺失、HTTP 5xx 和调用上限；错误响应正文不进入异常、日志或持久化。
- 阶段 2A 专项集成：14 个用例通过，覆盖角色双向拒绝、跨租户 RLS、多产品金额精度、provider 合约成功/超时/限流/解析失败/失败、重试、人工校正、失联租约恢复、供应商身份反向断言、并发 CAS、审计失败回滚、链头校验回滚、不可变快照和敏感审计投影。
- API 全量集成：20 个文件、373 个用例全部通过。
- `044` 与 `043` 在隔离测试库回滚后以相同 checksum 重放通过。
- `pnpm --filter @kirindesk/api typecheck` 通过。

测试中的两条预期 500 日志由故障注入产生，分别证明审计插入失败和链头校验失败会关闭并回滚报价事务。

### 官方 smoke 脱敏证据

- UTC：2026-07-31T03:36:28Z 至 2026-07-31T03:36:29Z
- 结果：HTTP 200；内置合成 fixture 严格 JSON 结构校验通过
- 模型：请求 `deepseek-chat`；供应商响应 `deepseek-v4-flash`
- 用量：prompt 74、completion 15、total 89 tokens
- 保守估算费用：人民币 0.004450 元
- 脱敏响应：517 bytes；SHA-256 `a9f9d7acd3190cee9bf22ef9453172cc15e741b0fe8b83b040293c9db82c19e9`
- 调用次数：1；未重试；未发送客户、联系人、询盘或其他业务数据

## 迁移与回滚

`044` 是加法迁移，不转换或删除既有业务数据。它为 `users`、`suppliers` 和 `provider_invocations` 增加租户复合唯一约束，以支持同租户复合外键；现有主键已保证 ID 唯一，因此不会改变现有记录含义。

回滚顺序由迁移 DOWN 段执行：先删除选价快照、报价行、报价头、报价任务和询盘行，再删除询盘头及新增复合唯一约束。回滚会删除全部阶段 2A 数据，只允许在隔离环境或确认无须保留 2A 数据时执行；若已有验收数据，应先备份新表并优先前滚修复。

代码回滚需要同时移除 `InquiriesModule` 注册和新权限目录。通用审计查询的敏感报价过滤应与报价专用审计端点一起回滚，避免出现完整证据无授权读取入口或重新暴露到通用导出的不一致状态。

## 风险与批准门禁

当前批准已确定官方 API、人民币 1 元上限、最多 5 次真实 smoke 请求和仅合成数据。未来补做 Secret 绑定时，Secret 必须测试专用、可撤销并以 `DEEPSEEK_API_KEY` 的 `secret_ref` 注入，不得写入仓库、普通环境文件、评论、日志或数据库。

Secret 绑定后执行：

```bash
AI_TEXT_PROVIDER=deepseek \
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions \
DEEPSEEK_MODEL=deepseek-chat \
DEEPSEEK_TEST_BUDGET_CNY=1 \
DEEPSEEK_TEST_MAX_CALLS=1 \
pnpm --filter @kirindesk/api verify:deepseek
```

该命令只发送内置合成 fixture，输出 endpoint、模型、UTC 时间、调用次数、token 数、保守费用、响应长度和 SHA-256，不输出 prompt、key 或供应商原始响应。官方成功证据已在上方记录；未来仅在轮换后的 Secret 完成安全绑定后按需复跑。任何本地或受控上游结果都不得冒充官方网络成功。

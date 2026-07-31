# 阶段 1：安全基础与工程门禁交付说明

- 状态：待 Kai 独立评审
- 分支：`feat/kir-5-stage-1`
- 基线：`main@ed895407da8659c5425c7ef65ef3c6d12b4a54ae`
- 范围来源：已接受的 KIR-4 plan revision 4 与 KIR-5 验收标准

## 范围与验收

本阶段只交付安全基础、工程门禁和可复现测试环境，不实现新版十二步业务流程，也不把现有 mock AI、mock 支付或占位 admin 视为产品能力。

- 真实执行 web、admin、API、database 的 lint/typecheck/build 与已有 unit/integration tests。
- 建立 PostgreSQL、Redis、MinIO、Chromium 的可复现测试条件和 CI。
- 清除 high 生产依赖；仅允许带证据、责任人和到期日的非适用例外。
- 建立可撤销 tenant/platform 会话、逐请求账号状态复查、登录限流和安全审计。
- 保持跨租户、权限越界、字段投影和金额精度回归。
- 把用户、文件、AI 配额更新改为与权威写入同事务、行锁串行化。
- 提供迁移 up/down 或前滚恢复演练及明确回滚说明。

## 完成项

### 工程与依赖

- 新增根级 ESLint flat config，移除 web/admin/database 的占位 lint/build。
- 删除 7 个无源码且无运行时引用的空壳 workspace package；活动 workspace 为 root、api、web、admin、database。
- 新增 `.github/workflows/quality-gate.yml`、Playwright 配置和两项浏览器回归。
- 固定 PostgreSQL 16.10、Redis 7.4.5、MinIO 2025-04-22 和 MinIO Client 2025-04-16 镜像；Compose healthcheck 与 bucket 初始化已验证。
- 升级 Nodemailer、Multer 和 React Router，生产审计只剩一条未发布可用补丁且不适用于当前 declarative mode 的 RSC 通告。

### 认证与会话

- 新增 `auth_sessions` 会话账本，tenant/platform 会话使用不同 RLS 策略，应用角色无 DELETE 权限。
- JWT 增加 `sid`；每次认证请求复查会话未撤销、未过期、账号启用、租户启用。
- tenant/platform logout 都在服务端撤销当前会话并写入 hash 链审计。
- Redis 同时按 IP 与规范化身份 hash 限流；Redis 缺失或异常时登录返回 503，不静默绕过安全控制。
- 每个窗口第一次越限写入 `auth:login_rate_limited`；后续越限不重复写入，避免审计放大。

### 配额一致性

- 用户创建/启停与 `user_count` 在同一事务更新。
- 用户启停、软删除和文件软删除先锁定权威状态行；用户席位只在 `active` 边界被跨越时释放，`inactive -> deleted` 不减计，重复或跨入口并发请求不会二次释放。
- 文件上传先锁定并消费精确字节配额，再上传对象和写入元数据；事务失败补偿删除对象。
- 成功 AI/provider invocation 与 `ai_calls_month` 在同一事务更新；失败 invocation 不消费成功配额。
- 配额行使用 `FOR UPDATE` 串行化；并发只剩一个席位时自动化测试证明恰好一个请求成功。
- 确定性行锁回归覆盖并发用户软删除、状态停用、状态停用与删除跨入口竞态以及文件软删除；用户用例同时断言配额快照等于 active 用户权威聚合。
- `043_reconcile_quota_usage.sql` 从 active users、active files 和当月成功 invocation 重算现有快照。

## 验证证据

| 门禁 | 结果 |
| --- | --- |
| Compose | PostgreSQL、Redis、MinIO 均 healthy；`minio-init` 成功创建 `kirindesk-files` |
| `pnpm verify:fast` | 通过；4 个活动 workspace 真 lint/typecheck/build，65 个 unit tests 通过 |
| `pnpm test:integration` | 19/19 文件、358/358 测试通过；包含 4 条并发释放回归 |
| `pnpm verify:migrations` | 043、042 依次 down，再依次 up；文件名和校验和恢复一致 |
| `pnpm test:security` | 19/19 通过 |
| `pnpm test:e2e` | Chromium 2/2 通过 |
| `pnpm audit:prod` | 通过；0 条未处置 high/critical，1 条有时限例外 |

完整集成套件包含现有跨租户 RLS、权限越界、DTO/响应字段、订单金额字符串、负数和超精度拒绝等回归；新增认证测试覆盖 tenant/platform logout、账号停用、租户暂停、跨租户 sid 重放和 429 限流。

## 迁移影响

- `042_auth_sessions.sql` 新增会话表、索引、RLS 和最小权限，不修改现有用户或业务表。
- 发布后，缺少 `sid` 的旧 JWT 会明确失效，所有用户需要重新登录。这是阶段 0 已约定的会话切换策略，不是兼容性缺陷。
- `043_reconcile_quota_usage.sql` 只把派生快照修正为权威业务行的计数，不删除业务数据。
- 本轮并发状态转换修复不新增或修改数据库迁移。
- 测试迁移演练只允许 `kirindesk_test`，未使用生产数据。

## 回滚

1. 应用回滚到阶段 1 前提交时，不得让旧 JWT 重新获得有效性；应同步轮换 tenant/platform JWT secret，或保留兼容的 session-aware 验证层直到旧 token 最长 TTL 结束。
2. `043` 的 DOWN 是有意的前滚恢复：保留已纠正的派生计数，避免恢复已知错误快照。
3. `042` 可在应用不再读取会话表后回滚；生产常规回滚建议保留会话审计数据，不以删表作为默认动作。
4. Compose/CI/空壳 package 清理可通过回退本分支提交恢复，不影响业务数据。
5. 并发状态转换修复无 schema 依赖，可单独回退应用代码；但该回退会重新引入重复释放风险，回退后必须立即执行 `043` 的前滚对账，且不得作为可批准发布状态。

## 残余风险与未完成项

- React Router `GHSA-qwww-vcr4-c8h2` 只影响未使用的 unstable RSC API；例外责任人为 Rin，2026-08-30 到期。到期、启用 RSC 或可用补丁发布三者任一发生即必须移除例外并升级。
- 登录依赖 Redis 并采用失败关闭；Redis 故障期间登录返回 503，现有已认证会话仍由 PostgreSQL 校验。发布前应为 Redis 配置告警。
- 现有 web 仍使用 localStorage 保存访问令牌，前端信息架构与会话存储重写不在本阶段宣称完成。
- 现有 admin 仍是占位应用；本阶段只证明其真实 lint/typecheck/build，不把它计为已完成平台控制台。
- AI/OCR、支付和部分通知仍包含 mock/实验路径；本阶段没有把这些路径升级为真实产品能力。

# 阶段 3：迁移演练与发布候选交付说明

- 状态：待 Kai 独立评审；不是生产发布批准
- 分支：`feat/kir-13-stage-3`
- 基线：阶段分支直接基于已批准的 `e933ab1`；不含旧版 2G 分叉实现
- 数据边界：只使用 loopback PostgreSQL 的 `kirindesk_test`、本地 Redis DB 1 和 loopback MinIO；未读取生产凭据或客户数据
- 数据库变更：无新增 migration；随机影子库由正式 migrator 建立 `049` 基线，复制隔离测试库中所有可由 `049` 表达的真实持久化事实，再真实前滚 `050_stage_2f_samples_after_sales.sql`

## 范围与验收

本阶段把阶段 2 的真实业务闭环收口为可复现发布候选，覆盖影子迁移、数据库与对象存储备份恢复、应用回滚保护、SLO/告警、错误聚合、性能与安全回归，以及生产镜像重建。生产发布、真实告警接收渠道和任何外部供应商成本仍需负责人明确批准。

| 验收项 | 实现与证据 |
| --- | --- |
| 影子迁移与对账 | `pnpm verify:release-data` 在随机影子库用正式 migrator 建立 `049` schema/账本基线，复制 `kirindesk_test` 中全部 `049` 可表达事实，再由同一 migrator 实际应用 `050`；前滚前后按 migration checksum、既有表行数、租户分布、所有 numeric 精确汇总、外键孤儿和审计 hash 链做零变化对账，并验证 `050` 新表真实出现 |
| PostgreSQL 备份恢复 | 使用 PostgreSQL 16.10 `pg_dump` custom archive 恢复到随机临时库；源库与恢复库按全表数量、租户归属、numeric 汇总、孤儿记录和 hash 链比较，结束后清理临时库与 dump |
| MinIO 备份恢复 | `pnpm verify:release-storage` 只接受 loopback S3 端点，写入随机 canary，把源 bucket 对象恢复到随机 bucket，再按对象 key、字节数和 SHA-256 对账并清理 |
| 应用回滚与数据保留 | `WORKFLOW_RELEASE_MODE=read_only` 允许查询但以 423 拒绝新版业务写入；`hidden` 以 404 隐藏新版 API 并移除前端入口，客户等既有核心 API 保持可用；演练断言业务行数不变 |
| 完整业务与角色回归 | API 集成套件覆盖阶段 2A–2G、跨租户 RLS、权限越界、金额精度和 hash 链；Chromium、Firefox、WebKit 使用同一套真实 API/PostgreSQL 路径覆盖 PI/收款闸门、拆分履约、财务/利润/提成、样品、售后、五类角色导航与登录隔离 |
| SLO、告警与错误聚合 | `/metrics` 提供按 method/route/status 聚合的请求计数和时延 histogram；5xx 写入不含请求体/租户数据的结构化 `request_error` 日志；Prometheus 配置含不可用、5xx 快速燃烧和 p95 时延三条规则 |
| 隔离重建 | `.env.production.example` 只含占位值；生产 Compose config、Prometheus config/rules、API/Web 镜像构建均在本地隔离环境验证 |

## 发布模式

| `WORKFLOW_RELEASE_MODE` | 服务端行为 | 前端行为 | 数据行为 |
| --- | --- | --- | --- |
| `active` | 新版业务读写正常 | 显示全部获权入口 | 正常持久化 |
| `read_only` | GET/HEAD/OPTIONS 正常；新版业务写请求返回 423 `WORKFLOW_READ_ONLY` | 显示“业务闭环只读”提示 | 不删除、不迁移、不新增新版业务行 |
| `hidden` | 新版业务 API 返回 404；客户、供应商、既有订单和治理 API 不受影响 | 隐藏新版工作流导航并显示停用说明 | 新版表和对象原样保留 |

发布模式由服务端全局 guard 执行，前端可见性不是安全边界。无效配置会在应用模块初始化时失败，避免拼写错误静默回到可写状态。

## SLO 与告警

- 可用性目标：滚动 30 天内 API 成功可用率不低于 99.9%，计划维护窗口单独记录。
- 错误率目标：10 分钟窗口 5xx 比例低于 1%；5 分钟超过 5% 且持续 10 分钟触发 critical 快速燃烧告警。
- 延迟目标：API 10 分钟窗口 p95 不高于 750ms，持续 15 分钟超标触发 warning。
- 探活目标：Prometheus 连续 2 分钟无法抓取 API 即触发 critical。
- 性能门禁：隔离环境先真实登录，再以 120 次并发请求平均覆盖角色工作台、询盘列表和凭证链递归查询，读取完整响应体并要求每条路径 p95 不高于 500ms；该门禁是回归预算，不替代容量测试。

Prometheus 使用 `ops/prometheus/prometheus.yml` 和 `ops/prometheus/alerts.yml`。生产告警通知渠道未自行选择；接入 PagerDuty、企业微信或其他外部接收端涉及成本和负责人选择，仍由 Kai 升级确认。

## 告警处置

1. `KirinDeskApiUnavailable`：检查 `/healthz`、`/readyz`、API 容器退出原因和 PostgreSQL 连通性；不要以超级用户连接串启动 API。
2. `KirinDeskErrorBudgetFastBurn`：按结构化日志中的 `errorId`、route、status 聚合定位；禁止记录请求体、token、客户原文或供应商证据。
3. `KirinDeskApiP95LatencyHigh`：先按 route/status histogram 定位，再检查数据库慢查询、锁等待和依赖健康；未定位前不要提高阈值掩盖回归。
4. 涉及跨租户、认证绕过、数据丢失或 hash 链失败时立即停止候选交付并升级 Kai。

## 迁移与恢复步骤

### 隔离演练

```bash
pnpm verify:full
pnpm verify:release
docker compose -f docker-compose.prod.yml --env-file .env.production.example config --quiet
docker compose -f docker-compose.prod.yml --env-file .env.production.example build api web
```

`verify:release-data` 会同时拒绝非 loopback PostgreSQL 和任何数据库名不是 `kirindesk_test` 的源连接；`verify:release-runtime` 还要求管理库与应用库同为 loopback 上的 `kirindesk_test`、位于同一实例，并固定使用本地 Redis DB 1；对象恢复会拒绝非 loopback S3 端点。随机影子库、恢复库、dump、canary 和恢复 bucket 均在结束时清理。影子迁移不执行任何 DOWN，也不删除源库中的样品、售后或其他阶段 2 事实；`049` 无法表达的 `050` 专属事实不进入前滚输入，完整恢复副本另行对 90 张表做全量对账并保留这些事实。

### 候选回滚

1. 将 `WORKFLOW_RELEASE_MODE` 切到 `read_only`，确认新版 GET 为 200、写入为 423，并完成 PostgreSQL 与对象存储备份。
2. 回滚应用镜像或代码版本，但保留 044–050 schema 和所有新版数据；生产回滚不得执行 migration DOWN。
3. 若旧应用不应暴露新版入口，将模式切到 `hidden`；新版数据继续只读保留，既有核心 API 保持可用。
4. 修复后先在影子副本执行前滚、对账和完整门禁，再恢复 `active`。
5. 只有确认备份本身损坏或发生数据灾难时才考虑从备份恢复；该动作必须由 Kai 审核并由负责人批准。

## 当前验证证据

| 门禁 | 结果 |
| --- | --- |
| `pnpm verify:fast` | lint、格式、全 workspace typecheck/build/unit 与生产依赖审计通过；唯一 high 通告按有责任人和到期日的现有例外失败关闭 |
| Unit | API 16 文件、82/82；Database 3 文件、22/22 通过 |
| API integration | 26 文件、413/413 通过 |
| 三浏览器 E2E | Chromium、Firefox、WebKit 共 6 文件、45/45 通过 |
| Migration round-trip | `050`、`049` 依次 DOWN 后按原 checksum 前滚恢复通过 |
| 影子迁移 | 正式 migrator 从 `049` 基线实际前滚 `050`（221ms）；76 张既有表/553 行、39 个租户分区、82 个 numeric 列、0 孤儿、3 条 hash 链/67 条审计记录前后完全一致；候选形成 90 张表，迁移账本与当前候选 checksum 全量一致 |
| PostgreSQL 恢复 | 90 表/566 行、48 个租户分区、93 个 numeric 列、0 孤儿、3 条 hash 链/67 条审计记录与源库一致；比 `049` 输入多出的 13 行 `050` 样品/售后事实完整保留 |
| MinIO 恢复 | 30 个对象按字节数与 SHA-256 对账通过 |
| 应用回滚 | 只读 GET 200 / POST 423，5 条询盘事实保持；隐藏 workflow 404 / core 200 |
| 性能回归 | 120 个真实业务请求；整体 p95 161.07ms，工作台 151.65ms、询盘列表 161.07ms、凭证链 103.21ms，逐路径预算 500ms |
| Prometheus | config 通过；3 条规则通过 promtool |
| 安全回归 | 19/19 通过 |
| 生产镜像 | Compose config 通过；API/Web Docker Compose build 通过 |

## 风险与审核边界

- 本阶段没有生产发布权限，不创建发布标签、不合并 `main`，也不把候选状态视为 Kai 已批准。
- 单机 Compose 不提供多可用区或自动故障转移；当前 SLO 以单实例可观测和可恢复为基础。
- Prometheus 规则可审计且能进入 firing 状态，但外部通知接收器未配置；供应商与费用需要负责人决策。
- 错误聚合当前由低基数 metrics 和结构化 stdout 完成，不引入外部错误平台，也不记录业务载荷。
- 阶段 3 分支已重新指向已批准的 `e933ab1`，旧 `272eb6` 分叉中的 2G 实现和证据未带入候选。
